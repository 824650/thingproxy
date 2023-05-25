var http = require('http');
var https = require('https');
var config = require("./config");
var url = require("url");
var request = require("request");
var cluster = require('cluster');
var throttle = require("tokenthrottle")({ rate: config.max_requests_per_second });

http.globalAgent.maxSockets = Infinity;
https.globalAgent.maxSockets = Infinity;

var publicAddressFinder = require("public-address");
var publicIP;

// Get our public IP address
publicAddressFinder(function (err, data) {
  if (!err && data) {
    publicIP = data.address;
  }
});

// Create a basic home page HTML
var homePageHTML = `
<html>
<head>
<meta name="google-site-verification" content="g53bgAt5Of2A6WvvX5hksOeSDegpwii4m07EQAtBRBM" />
    <title>ThingProxy Home</title>
</head>
<body>
    <h1>Welcome to ThingProxy</h1>
    <p>ThingProxy allows you to fetch and proxy web content.</p>
    <p>To use ThingProxy, send a request to /fetch/{URL} where {URL} is the URL of the content you want to fetch.</p>
    <p>For example, to fetch and proxy https://www.example.com, send a request to /fetch/https://www.example.com</p>
</body>
</html>
`;

function addCORSHeaders(req, res) {
  if (req.method.toUpperCase() === "OPTIONS") {
    if (req.headers["access-control-request-headers"]) {
      res.setHeader(
        "Access-Control-Allow-Headers",
        req.headers["access-control-request-headers"]
      );
    }

    if (req.headers["access-control-request-method"]) {
      res.setHeader(
        "Access-Control-Allow-Methods",
        req.headers["access-control-request-method"]
      );
    }
  }

  if (req.headers["origin"]) {
    res.setHeader("Access-Control-Allow-Origin", req.headers["origin"]);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
}

function writeResponse(res, httpCode, body) {
  res.statusCode = httpCode;

  if (httpCode === 200 && !body) {
    res.setHeader("Content-Type", "text/html");
    res.end(homePageHTML);
  } else {
    res.end(body);
  }
}

function sendInvalidURLResponse(res) {
  res.setHeader("Content-Type", "text/html");
  res.statusCode = 404;
  res.write(homePageHTML);
  res.end("<h1>404 - Page Not Found</h1><p>URL must be in the form of /fetch/{some_url_here}</p>");
}

function sendTooBigResponse(res) {
  return writeResponse(
    res,
    413,
    "the content in the request or response cannot exceed " +
      config.max_request_length +
      " characters."
  );
}

function getClientAddress(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0] || req.connection.remoteAddress;
}

function processRequest(req, res) {
  addCORSHeaders(req, res);

  if (req.method.toUpperCase() === "OPTIONS") {
    return writeResponse(res, 204);
  }

  if (req.url === "/") {
    return writeResponse(res, 200);
  }

  var result = config.fetch_regex.exec(req.url);

  if (result && result.length == 2 && result[1]) {
    var remoteURL;

    try {
      remoteURL = url.parse(decodeURI(result[1]));
    } catch (e) {
      return sendInvalidURLResponse(res);
    }

    if (!remoteURL.host) {
      return writeResponse(res, 404, "relative URLS are not supported");
    }

    if (config.blacklist_hostname_regex.test(remoteURL.hostname)) {
      return writeResponse(res, 400, "naughty, naughty...");
    }

    if (remoteURL.protocol != "http:" && remoteURL.protocol !== "https:") {
      return writeResponse(res, 400, "only http and https are supported");
    }

    if (publicIP) {
      if (req.headers["x-forwarded-for"]) {
        req.headers["x-forwarded-for"] += ", " + publicIP;
      } else {
        req.headers["x-forwarded-for"] = req.clientIP + ", " + publicIP;
      }
    }

    if (req.headers["host"]) {
      req.headers["host"] = remoteURL.host;
    }

    delete req.headers["origin"];
    delete req.headers["referer"];

    var proxyRequest = request({
      url: remoteURL,
      headers: req.headers,
      method: req.method,
      timeout: config.proxy_request_timeout_ms,
      strictSSL: false,
    });

    proxyRequest.on("error", function (err) {
      if (err.code === "ENOTFOUND") {
        return writeResponse(
          res,
          502,
          "Host for " + url.format(remoteURL) + " cannot be found."
        );
      } else {
        console.log(
          "Proxy Request Error (" + url.format(remoteURL) + "): " + err.toString()
        );
        return writeResponse(res, 500);
      }
    });

    var requestSize = 0;
    var proxyResponseSize = 0;

    req.pipe(proxyRequest)
      .on("data", function (data) {
        requestSize += data.length;

        if (requestSize >= config.max_request_length) {
          proxyRequest.end();
          return sendTooBigResponse(res);
        }
      })
      .on("error", function (err) {
        writeResponse(res, 500, "Stream Error");
      });

    proxyRequest.pipe(res)
      .on("data", function (data) {
        proxyResponseSize += data.length;

        if (proxyResponseSize >= config.max_request_length) {
          proxyRequest.end();
          return sendTooBigResponse(res);
        }
      })
      .on("error", function (err) {
        writeResponse(res, 500, "Stream Error");
      });
  } else {
    return sendInvalidURLResponse(res);
  }
}

if (cluster.isMaster) {
  for (var i = 0; i < config.cluster_process_count; i++) {
    cluster.fork();
  }
} else {
  http
    .createServer(function (req, res) {
      // Process AWS health checks
      if (req.url === "/health") {
        return writeResponse(res, 200);
      }

      var clientIP = getClientAddress(req);

      req.clientIP = clientIP;

      // Log our request
      if (config.enable_logging) {
        console.log(
          "%s %s %s",
          new Date().toJSON(),
          clientIP,
          req.method,
          req.url
        );
      }

      if (config.enable_rate_limiting) {
        throttle.rateLimit(clientIP, function (err, limited) {
          if (limited) {
            return writeResponse(res, 429, "enhance your calm");
          }

          processRequest(req, res);
        });
      } else {
        processRequest(req, res);
      }
    })
    .listen(config.port);

  console.log(
    "thingproxy.freeboard.io process started (PID " + process.pid + ")"
  );
}
