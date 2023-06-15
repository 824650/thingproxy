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
<!DOCTYPE html>
<html>
<head><link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat&display=swap" rel="stylesheet">
<meta name="google-site-verification" content="g53bgAt5Of2A6WvvX5hksOeSDegpwii4m07EQAtBRBM" />
  <title>JonathanProxy</title>
  <style>
    body {
      font-family: Montserrat, sans-serif;
      margin: 0;
      padding: 20px;
      background-color: rgb(7,23,43);
        color:white;

    }
    
    h1 {
      text-align: center;
    }
    
    #proxy-form {
      text-align: center;
      margin-top: 20px;
    }
    
    #proxy-url {
      width: 400px;
      padding: 10px;
      font-size: 16px;
      border: 1px solid #ccc;
      border-radius: 10px;
      border:none;
    }
    
    #proxy-submit {
      margin-top: 10px;
      padding: 10px 20px;
      font-size: 16px;
      background-color: #4CAF50;
      color: white;
      border: none;
      border-radius: 10px;
      cursor: pointer;
            border:none;

    }
  </style>
</head>
<body>
  <h1>JonathanProxy</h1>
  <script>
  document.addEventListener("DOMContentLoaded", function() {
  var proxyForm = document.getElementById("proxy-form");
  var proxyUrlInput = document.getElementById("proxy-url");

  proxyForm.addEventListener("submit", function(event) {
    event.preventDefault();
    var url = proxyUrlInput.value.trim();

    if (url !== "") {
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = "https://" + url;
      }

      window.location.href = "https://jonathanproxy.onrender.com/fetch/" + url;
    }
  });
});

</script>
  <form id="proxy-form" action="https://jonathanproxy.onrender.com/fetch/" method="GET">
    <input type="text" id="proxy-url" name="url" placeholder="Enter URL Here">
    <input type="submit" id="proxy-submit" value="Proxy">
  </form><br>
  <a href="https://github.com/Freeboard/thingproxy" style="color:white; text-decoration: none;"><span style="position:relative; left:60px">Powered by ThingProxy</span></a>
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

    // Check if the request is coming from an <a> or <form> element
    var referrer = req.headers["referer"];
    var isFromAnchorTag = referrer && referrer.startsWith("https://jonathanproxy.onrender.com/");
    var isFromForm = req.headers["content-type"] === "application/x-www-form-urlencoded";

    if (isFromAnchorTag) {
      var urlPath = result[1];

      if (!urlPath.startsWith("http://") && !urlPath.startsWith("https://")) {
        // Modify the URL to include the proxy route
        var proxyURL = "https://jonathanproxy.onrender.com/fetch/" + urlPath;
        remoteURL = url.parse(proxyURL);
      }
    }

    if (!remoteURL.host) {
      return writeResponse(res, 404, "relative URLs are not supported");
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

    var body = "";

    proxyRequest.on("data", function (data) {
      requestSize += data.length;

      if (requestSize >= config.max_request_length) {
        proxyRequest.end();
        return sendTooBigResponse(res);
      }

      body += data.toString();
    });

proxyRequest.on("end", function () {
  // Send the modified proxied HTML response
  if (body) {
    // Send the modified proxied URL as the <base> tag in the response
    var baseTag = '<base href="' + "https://jonathanproxy.onrender.com/fetch/" + remoteURL.href + '">';

    // Modify the proxied website to include the <base> tag
    var modifiedBody = body.replace(/<head(\s[^>]*?)?>/i, function (match, attributes) {
      return '<head' + attributes + '>' + baseTag;
    });

    // Send the modified response
    writeResponse(res, 200, modifiedBody);
  } else {
    writeResponse(res, 200, body);
  }
});



    proxyRequest.on("error", function (err) {
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
