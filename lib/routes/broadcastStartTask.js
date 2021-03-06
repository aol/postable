var request = require('request');
var ndjson = require('ndjson');

module.exports = function (app, config) {

	return function broadcastStartTask(req, res) {

		// Start broadcasting to all the hosts.

		var clusters = req.query.cluster;
		clusters = clusters ? (Array.isArray(clusters) ? clusters : [clusters]) : null;
		var pending = clusters ? clusters.length : config.broadcastUris.length;

		res.write(JSON.stringify({ meta: { broadcastClusters: pending } }) + "\n");

		config.broadcastUris.forEach(function (uri) {

			var options = {
				method: 'POST',
				url: uri + '/buckets/' + encodeURIComponent(req.params.bucket) + '/tasks/',
				headers: { 'request-id': req.requestId },
				body: req.body,
				json: true,
				qs: req.query,
				auth: req.user ? { username: req.user.name, password: req.user.pass } : null
			};

			var call = request(options);
			var callStatus = 0;
			var callClusterId = null;

			function sendError(status, description) {
				res.write(JSON.stringify({
					clusterId: callClusterId,
					meta: { error: { status: status, description: description || null } }
				}) + "\n");
			}

			function sendLine(object) {
				object.clusterId = callClusterId;
				res.write(JSON.stringify(object) + "\n");
			}

			function broadcastErrorHandler(message, description, end) {
				return function (e) {
					var context = { status: callStatus, error: e || null };
					req.log.error(message, context);
					sendError(callStatus, description);
					end && broadcastStep();
				};
			}

			function broadcastStep() {
				--pending || complete();
			}

			call.on('response', function (broadcastResponse) {
				callStatus = broadcastResponse.statusCode;
				callClusterId = broadcastResponse.headers['x-postable-cluster-id'] || null;
				if (callStatus !== 200) {
					if (callStatus !== 204) {
						broadcastErrorHandler(
							'Unsuccessful broadcast (HTTP ' + (callStatus || '?') + ') to ' + uri,
							'connected_with_unsuccessful_status_code'
						)();
					}
				} else if (!callClusterId) {
					callStatus = 0;
					broadcastErrorHandler(
						'Unsuccessful broadcast (no X-Postable-Cluster-Id header) to ' + uri,
						'connected_with_no_cluster_id'
					)();
				}
			});

			call.on('error', broadcastErrorHandler(
				'Could not broadcast to ' + uri,
				'error_calling_broadcast_receiver',
				true
			));
			call.on('end', broadcastStep);

			var jsonStream = call.pipe(ndjson.parse({ strict: false }));

			jsonStream.on('data', function (object) {
				sendLine(object);
			});
		});

		function complete() {
			res.end();
		}
	};
};