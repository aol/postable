require('es6-collections');
var express = require('express');
var bodyParser = require('body-parser');
var basicAuth = require('basic-auth');
var expressWinston = require('express-winston');
var fs = require('fs');
var requestId = require('./requestId');
var log = require('./log');
var redis = require('./redis')(log);
var clusterId = require('./clusterId')(redis);
var env = process.env;

var app = express();
app.redis = redis;
app.clusterId = clusterId;
app.disable('x-powered-by');
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

var port = env.POSTABLE_PORT || 3000;
var config = {
	listenerSetTimeoutSeconds: +(env.POSTABLE_LISTENER_SET_TIMEOUT_SECONDS) || 1800, // 30 minutes
	listenerTimeoutSeconds: +(env.POSTABLE_LISTENER_TIMEOUT_SECONDS) || 20, // 20 seconds
	lastTaskTimeoutSeconds: +(env.POSTABLE_LAST_TASK_TIMEOUT_SECONDS) || 604800, // 7 days
	heartbeatMillis: +(env.POSTABLE_HEARTBEAT_MILLIS) || 5000, // 5 seconds
	broadcastUris: (env.POSTABLE_BROADCAST || '').split(';').map(function (uri) {
		return uri.replace(/\/+$/, '').trim() || null;
	}).filter(function (uri) {
		return !!uri;
	})
};

// Append a request-id to each request.

app.use(requestId.middleware);

// Add a contextual logger to the request.

app.use(function (req, res, next) {
	req.log = log.createContext({ requestId: req.requestId });
	next();
});

// Emit a message at the top of every request for level 1 (debug) or more.

var logLevel = log.levels[log.level];
if (logLevel <= 1) {
	app.use(function (req, res, next) {
		req.log.debug('postable_request_received: ' + req.method + ' ' + req.originalUrl, {
			requestIps: req.ips,
			requestUrl: req.originalUrl,
			requestHostname: req.hostname,
			requestMethod: req.method,
			requestBody: req.body
		});
		next();
	});
}

// Attach an access logger for any level 2 (verbose) or more.

if (log.levels[log.level] <= 2) {
	app.use(function (req, res, next) {
		expressWinston.logger({
			winstonInstance: req.log,
			msg: 'HTTP {{req.method}} {{req.url}}'
		})(req, res, next);
	});
}

// Append cluster ID to all responses in a header.

app.use(function (req, res, next) {
	clusterId(function (id) {
		if (id) {
			req.currentClusterId = id;
			res.set('X-Postable-Cluster-ID', id);
		}
		next();
	});
});

// Set the connection response header to close.

app.use(function (req, res, next) {
	res.set('Connection', 'close');
	next();
});

// Basic auth.

if (env.POSTABLE_AUTH_USER && env.POSTABLE_AUTH_PASS) {
	log.info('Postable basic auth enabled.');
	app.use(function (req, res, next) {
		if (req.url === '/') {
			return next();
		}
		var user = basicAuth(req);
		if (!user || user.name !== env.POSTABLE_AUTH_USER || user.pass !== env.POSTABLE_AUTH_PASS) {
			res.statusCode = 401;
			res.setHeader('WWW-Authenticate', 'Basic realm="all"');
			res.end('Unauthorized');
		} else {
			req.user = user;
			next();
		}
	});
}

var routes = { };
var files = fs.readdirSync(__dirname + '/routes').forEach(function (file) {
	var routeKey = file.replace(/\.js$/, '');
	routes[routeKey] = require(__dirname + '/routes/' + file)(app, config);
});

// Service up check endpoint.
app.get('/', routes.checkServiceUp);

// Routes for this cluster.
app.get('/buckets/:bucket/tasks/last', routes.clusterGetLastTask);
app.get('/buckets/:bucket/listeners/', routes.clusterGetListeners);
app.post('/listeners/', routes.clusterListenForTasks);
app.post('/tasks/:taskId/results/:listenerId', routes.clusterSendTaskResult);
app.post('/buckets/:bucket/tasks/', routes.clusterStartTask);
if (config.broadcastUris.length) {
	app.post('/broadcast/buckets/:bucket/tasks/', routes.broadcastStartTask);
}

var server = app.listen(port, function () {
	var host = server.address().address;
	var port = server.address().port;
	log.info('Postable listening at http://' + host + ':' + port);
});

server.app = app;
module.exports = server;