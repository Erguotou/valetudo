const express = require("express");
const http = require("http");
const compression = require("compression");
const path = require("path");
const fs = require("fs");
const spawnSync = require("child_process").spawnSync;
const zlib = require("zlib");
const crypto = require("crypto");
const bodyParser = require("body-parser");
const url = require("url");
const WebSocket = require("ws");
const dynamicMiddleware = require("express-dynamic-middleware");
const basicAuth = require("express-basic-auth");
const multer = require('multer');
const prettyCron = require("prettycron");

const SimpleMapDrawer = require("../SimpleMapDrawer");
const Vacuum = require("../miio/Vacuum");

const { exec } = require("child_process");

const Request = require('request');

const upload = multer({ dest: '/mnt/data/valetudo/uploads' });

/**
 *
 * @param valetudo {Valetudo}
 * @constructor
 */
const WebServer = function (valetudo) {
	const self = this;

	this.vacuum = valetudo.vacuum;
	this.port = valetudo.webPort;
	this.configuration = valetudo.configuration;
	this.events = valetudo.events;
	this.sshManager = valetudo.sshManager;
	this.cronScheduler = valetudo.cronScheduler;
	this.events = valetudo.events;
	this.cloud = valetudo.dummycloud;
	this.createInstance = valetudo.createInstance;
	this.mapManager = valetudo.mapManager;
	this.mqttClient = valetudo.mqttClient;
	this.telegramBot = valetudo.telegramBot;

	this.map = valetudo.map;

	this.mapUploadInProgress = {};
	this.basicAuthInUse = false;
	this.app = express();
	this.app.use(compression());
	this.app.use(bodyParser.json());

	this.uploadLocation = "/mnt/data/valetudo/uploads";
	fs.readdir(this.uploadLocation, (err, files) => {
		if(!err){ //remove all previous uploads
			for (const file of files) {
				fs.unlink(path.join(this.uploadLocation, file), (rmerr) => {});
			}
		}
	});

	const basicAuthUnauthorizedResponse = function(req) {
		return req.auth ? ('Credentials "' + req.auth.user + ':' + req.auth.password + '" rejected') : 'No credentials provided';
	};

	const basicAuthMiddleware = basicAuth({authorizer: function(username, password) {
		const userMatches = basicAuth.safeCompare(username, self.configuration.get("httpAuth").username);
		const passwordMatches = basicAuth.safeCompare(password, self.configuration.get("httpAuth").password);
		return userMatches & passwordMatches;
	}, challenge: true, unauthorizedResponse: basicAuthUnauthorizedResponse});

	const authMiddleware = function(req, res, next) {
		if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip)) {
			// Allow requests from localhost
			next();
		} else {
			// Authenticate other ones
			try {
				basicAuthMiddleware(req, res, next);
			} catch (e) { /* basicAuth throws [ERR_HTTP_HEADERS_SENT] here if invalid credentials are sent */ }
		}
	};
	const dynamicAuth = dynamicMiddleware.create([]);
	this.app.use(dynamicAuth.handle());

	if (this.configuration.get("httpAuth").enabled) {
		dynamicAuth.use(authMiddleware);
		this.basicAuthInUse = true;
	}

	this.app.put("/api/miio/map_slot_:slotID", function(req, res) {
		if (!self.mapUploadInProgress[req.params.slotID]) {
			self.mapUploadInProgress[req.params.slotID] = true;
			var data = [],
				ondata = chunk => data.push(chunk),
				onend = () => {
					req.off('data', ondata);
					req.off('end', onend);
					self.map.snapshots[req.params.slotID] = Buffer.concat(data);
					self.mapUploadInProgress[req.params.slotID] = false;
					res.sendStatus(200);
				}
			req.on('data', ondata);
			req.on('end', onend);
		} else {
			res.end();
			req.connection.destroy();
		}
	});

	this.app.get("/api/miio/map_slot_:slotID", function (req, res) {
		if (self.map.snapshots[req.params.slotID]) {
			res.send(self.map.snapshots[req.params.slotID]);
		} else {
			res.end();
		}
	});

	this.app.get("/api/map/latest", function (req, res) {
		if (self.map.bin) {
			res.send(self.map.bin);
		} else {
			res.end();
		}
	});

	this.app.get("/api/simple_map", function (req, res) {
		if (self.map.bin) {
			self.vacuum.getCurrentStatus(function (err, data) {
				if (err) {
					res.sendStatus(404);
					return;
				}
				let options = {gzippedMap: self.map.bin, status: data};
				if (req.query.scale !== undefined) options.scale = parseInt(req.query.scale);
				if (req.query.drawPath !== undefined) options.drawPath = parseInt(req.query.drawPath);
				if (req.query.useGradient !== undefined) options.useGradient = parseInt(req.query.useGradient);
				SimpleMapDrawer.drawMap(options,(err,data) => {
					if (!err && data) {
						res.contentType('image/png');
						res.end(data,'binary');
					} else {
						res.sendStatus(500);
					}
				});
			});
		} else {
			res.sendStatus(404);
		}
	});

	this.app.get("/api/poll_map", function (req, res) {
		self.events.emit("valetudo.dummycloud.pollmap");
		res.status(200).json({message: "ok"});
	});

	this.app.get("/api/current_status", function (req, res) { //TODO: use cloud interface?
		self.vacuum.getCurrentStatus(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				data.model = self.vacuum.model;
				res.json(data);
			}
		});
	});

	this.app.get("/api/consumable_status", function (req, res) {
		self.vacuum.getConsumableStatus(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				self.vacuum.getCleanSummary(function (err, data2) {
					if (err) {
						res.status(500).send(err.toString());
					} else {
						res.json({
							consumables: data,
							summary: data2
						});
					}
				});
			}
		});
	});

	this.app.get("/api/get_interface_config", function (req, res) {
		res.json(self.configuration.get("webInterface"));
	});

	this.app.put("/api/set_interface_config", function (req, res) {
		let config = {};
		if (req.body.localization && req.body.localization.length === 2) {
			config.localization = req.body.localization;
		}
		if (req.body.style) {
			config.style = req.body.style;
		}
		['zonedImmediate','gotoImmediate','showMultimap','hideMapStatus','staticMapButtons','hideSegmentMarkers'].forEach(option => {
			if (req.body[option]) {
				config[option] = true;
			}
		});
		self.configuration.set("webInterface",config);
		res.json({res:"success"});
	});

	this.app.get("/api/telegram_config", function (req, res) {
		res.json(self.configuration.get("telegramBot"));
	});

	this.app.get("/api/telegram_status", function (req, res) {
		res.json({
			running: !self.telegramBot ? 1 : self.telegramBot.getStatus()
		}); // if we have telegramBot = null then status is assumed to be 1 = disconnected
	});

	this.app.put("/api/telegram_config", function (req, res) {
		self.configuration.set("telegramBot", {
			enabled: req.body.enabled,
			token: req.body.token,
			password: req.body.password || '',
			host: req.body.host || '',
			proxy: req.body.proxy || '',
			clients: self.configuration.get("telegramBot").clients,
			sendConsumables: req.body.sendConsumables,
			sendConsumablesEvery: req.body.sendConsumablesEvery,
			notifyStatusTypes: +req.body.notifyStatusTypes || 0
		});
		if (req.body.enabled) {
			self.telegramBot && self.telegramBot.reload() || self.createInstance("tgbot");
		} else {
			self.telegramBot && self.telegramBot.stop();
		}
		res.json({res:"success"});
	});

	this.app.delete("/api/telegram_client/:clientID", function (req, res) {
		let telegramBotCfg = self.configuration.get("telegramBot"),
			len = telegramBotCfg.clients.length;
		telegramBotCfg.clients = telegramBotCfg.clients.filter(client => client.id !== +req.params.clientID);
		if (telegramBotCfg.clients.length !== len) {
			self.configuration.set("telegramBot", telegramBotCfg);
			self.telegramBot.reload();
			res.json({res:"success"});
		} else {
			res.status(404).send("No telegrambot with selected id.");
		}
	});

	this.app.get("/api/mqtt_config", function (req, res) {
		res.json(self.configuration.get("mqtt"));
	});

	this.app.put("/api/mqtt_config", function (req, res) {
		let values = self.configuration.get("mqtt");
		Object.assign(values, {
			enabled: !!req.body.enabled,
			broker_url: req.body.broker_url,
			caPath: req.body.caPath || '',
			qos: req.body.qos || 0,
			identifier: req.body.identifier || '',
			topicPrefix: req.body.topicPrefix,
			autoconfPrefix: req.body.autoconfPrefix,
			provideMapData: !!req.body.provideMapData
		});
		self.configuration.set('mqtt',values);
		if (values.enabled) {
			self.mqttClient && self.mqttClient.reload() || self.createInstance("mqtt");
		} else {
			self.mqttClient && self.mqttClient.stop();
		}
		res.json({res:"success"});
	});

	this.app.get("/api/get_fw_version", function (req, res) {
		var version, build, valetudo;
		version = build = valetudo = '?';
		new Promise((resolve,reject) => {
			fs.readFile("/etc/os-release", function (err, data) {
				if (!err) {
					const extractedOsRelease = data.toString().match(WebServer.OS_RELEASE_FW_REGEX);
					if (extractedOsRelease) {
						build = extractedOsRelease[11].split('_')[1];
					}
				}
				resolve();
			});
		})
		.then(_ => new Promise((resolve,reject) => {
			exec("/opt/rockrobo/miio/miio_client --version", (error, stdout, stderr) => {
				if (stderr) {
					version = stderr;
				}
				resolve();
			})
		}))
		.then(_ => {
			let packageContent = fs.readFileSync(path.resolve(__dirname, "../..") + '/package.json');
			if (packageContent) {
				packageContent = JSON.parse(packageContent);
				valetudo = 'v' + packageContent.version + (packageContent.versionSuffix ? packageContent.versionSuffix : '');
			}
		})
		.catch(_ => {})
		.finally(_ => {
			res.json({
				version: version,
				build: build,
				nodejs: require('process').version,
				valetudo: valetudo
			});
		});
	});

	this.app.get("/api/get_ota_state", function (req, res) {
		self.vacuum.getOtaState(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		});
	});

	this.app.get("/api/get_app_locale", function (req, res) {
		self.vacuum.getAppLocale(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		});
	});

	this.app.get("/api/wifi_status", function (req, res) {
		let err;
		const wifiConnection = {
			connected: false,
			connection_info: {
				bssid: null,
				ssid: null,
				freq: null,
				signal: null,
				tx_bitrate: null
			}
		};
		const iwOutput = spawnSync("iw", ["dev", "wlan0", "link"]).stdout;
		if (iwOutput) {
			const extractedWifiData = iwOutput.toString().match(WebServer.WIFI_CONNECTED_IW_REGEX);
			if (extractedWifiData) {
				wifiConnection.connected = true;
				wifiConnection.connection_info.bssid = extractedWifiData[1];
				wifiConnection.connection_info.ssid = extractedWifiData[2];
				wifiConnection.connection_info.freq = extractedWifiData[3];
				wifiConnection.connection_info.signal = extractedWifiData[4];
				wifiConnection.connection_info.tx_bitrate = extractedWifiData[5];
			}
		}
		res.json(wifiConnection);
	});

	this.app.get("/api/ztimers", function (req, res) {
		const ztimers = self.configuration.get("ztimers");
		res.json(ztimers.map(timer => ({
			enabled: timer[0],
			id: timer[1],
			cron: timer[2],
			human_desc: prettyCron.toString(timer[2].replace(/\ 0,1,2,3,4,5,6$/," *")),
			coordinates: timer[3],
			fanpower: timer[4] || null
		})));
	});

	this.app.put("/api/ztimers", function (req, res) {
		if (req.body.id && req.body.cron && Array.isArray(req.body.coordinates)) {
			// Todo: Extended validation
			const ntimer = [
				req.body.enabled || false,
				req.body.id,
				req.body.cron,
				req.body.coordinates,
				+req.body.fanpower || null
			];
			if (!self.cronScheduler) {
				self.createInstance("cron");
			}
			let checkTask = self.cronScheduler.checkSchedule(ntimer);
			if (checkTask !== true) {
				res.status(400).send("invalid timer: " + (checkTask || 'unspecified'));
			} else {
				const ztimers = self.configuration.get("ztimers");
				let idx = ztimers.findIndex(timer => timer[1] === (req.body.edit && req.body.edit.length ? req.body.edit : req.body.id));
				if (idx > -1) {
					ztimers[idx] = ntimer;
				} else {
					ztimers.push(ntimer)
				}
				self.configuration.set("ztimers", ztimers);
				res.status(201).json({message: "ok"});
			}
		} else {
			res.status(400).send("bad request body");
		}
	});

	this.app.put("/api/ztimers/:timerID", function (req, res) {
		if (req.body && req.params.timerID !== undefined) {
			const ztimers = self.configuration.get("ztimers");
			let idx = ztimers.findIndex(timer => timer[1] === req.params.timerID);
			if (idx < 0) {
				res.status(404).send("No timer with selected id.");
			} else {
				ztimers[idx][0] = !!req.body.enabled || false;
				self.configuration.set("ztimers", ztimers);
				if (!self.cronScheduler) {
					self.createInstance("cron");
				}
				res.status(201).json({message: "ok"});
			}
		} else {
			res.status(400).send("Invalid request");
		}
	});

	this.app.delete("/api/ztimers/:timerID", function (req, res) {
		const ztimers = self.configuration.get("ztimers");
		let idx = ztimers.findIndex(timer => timer[1] === req.params.timerID);
		if (idx < 0) {
			res.status(404).send("No timer with selected id.");
		} else {
			ztimers.splice(idx, 1);
			self.configuration.set("ztimers", ztimers);
			res.status(201).json({message: "ok"});
		}
	});

	this.app.get("/api/timers", function (req, res) {
		self.vacuum.getTimers(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		});
	});

	this.app.put("/api/timers", function (req, res) {
		if (req.body && req.body.cron && req.body.id) {
			new Promise((resolve,reject) => {
				if (req.body.edit && req.body.edit.length) {
					self.vacuum.deleteTimer(req.body.edit.replace(/ /g,"\u{a0}"), function (err, data) {
						if (err) {
							reject(err);
						} else {
							resolve(data);
						}
					})
				} else {
					resolve();
				}
			})
			.then(() => {
				return new Promise((resolve,reject) => {
					self.vacuum.addTimer({id: req.body.id.replace(/ /g,"\u{a0}"), cron: req.body.cron, fanpower: +req.body.fanpower, segments: req.body.segments, iterations: +req.body.iterations}, function (err, data) {
						if (err) {
							reject(err);
						} else {
							resolve(data);
						}
					});
				});
			})
			.then(data => res.json({message: "ok"}))
			.catch(err => res.status(500).send(err.toString()));
		} else {
			res.status(400).send("invalid request");
		}
	});

	this.app.put("/api/timers/:timerID", function (req, res) {
		if (req.body && req.body.enabled !== undefined) {
			self.vacuum.toggleTimer(req.params.timerID, req.body.enabled, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.json(data);
				}
			})
		} else {
			res.status(400).send("Invalid request");
		}
	});

	this.app.delete("/api/timers/:timerID", function (req, res) {
		self.vacuum.deleteTimer(req.params.timerID, function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		})
	});

	this.app.get("/api/get_dnd", function (req, res) {
		self.vacuum.getDndTimer(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		});
	});

	this.app.post("/api/set_dnd", function (req, res) {
		if (req.body && req.body.start_hour && req.body.start_minute && req.body.end_hour && req.body.end_minute) {
			self.vacuum.setDndTimer(req.body.start_hour, req.body.start_minute, req.body.end_hour, req.body.end_minute, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.json(data);
				}
			})
		} else {
			res.status(400).send("invalid request");
		}
	});

	this.app.put("/api/delete_dnd", function (req, res) {
		self.vacuum.deleteDndTimer(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		})
	});

	this.app.get("/api/get_timezone_list", function (req, res) {
		fs.readFile('/usr/share/zoneinfo/zone.tab', 'utf8', (err, data) => {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data.split('\n')
					.filter(line => line[0] !== '#')
					.map(line => { return line.split('\t')[2]; })
					.filter(line => line !== undefined)
					.sort()
				);
			}
		});
	});

	this.app.get("/api/get_timezone", function (req, res) {
		self.vacuum.getTimezone(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		});
	});

	this.app.post("/api/set_timezone", function (req, res) {
		if (req.body && req.body.new_zone) {
			self.vacuum.setTimezone(req.body.new_zone, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					if (self.cronScheduler) {
						self.cronScheduler.setTimezoneOffset(req.body.new_zone);
					}
					res.json(data);
				}
			})
		} else {
			res.status(400).send("invalid request");
		}
	});

	this.app.get("/api/clean_summary", function (req, res) {
		if (req.body) {
			self.vacuum.getCleanSummary(function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.json(data);
				}
			})
		} else {
			res.status(400).send("Invalid request");
		}
	});

	this.app.put("/api/clean_record", function (req, res) {
		if (req.body && req.body.recordId) {
			self.vacuum.getCleanRecord(req.body.recordId, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					//TODO: validate data from robot. Don't just hope that the array contains what we expect
					//TODO: Maybe move validation to Vacuum.js and trust the data here
					/*
					 * Positions in array:
					 * 0: startTS(sec)
					 * 1: endTS(sec)
					 * 2: duration(sec)
					 * 3: square-meter
					 * 4: errorCode
					 * 5: finishedFlag
					 */
					res.json({
						startTime: data[0][0] * 1000, //convert to ms
						endTime: data[0][1] * 1000, //convert to ms
						duration: data[0][2],
						area: data[0][3],
						errorCode: data[0][4],
						errorDescription: Vacuum.GET_ERROR_CODE_DESCRIPTION(data[0][4]),
						finishedFlag: (data[0][5] === 1)
					});
				}
			})
		} else {
			res.status(400).send("Invalid request");
		}
	});

	this.app.put("/api/clean_record_map", function (req, res) {
		if (req.body && req.body.recordId) {
			self.vacuum.getCleanRecordMap(req.body.recordId, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.status(201).json(data);
				}
			});
		} else {
			res.status(400).send("Invalid request");
		}
	});

	this.app.put("/api/start_cleaning", function (req, res) {
		self.vacuum.getCurrentStatus(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
				return;
			}

			if (data.in_cleaning === 3 && [2,10,12].includes(data.state)) {
				self.vacuum.resumeCleaningSegment((err, data) => {
					if (err) {
						res.status(500).send(err.toString());
					} else {
						res.json(data);
					}
				});
			} else if (data.in_cleaning === 2 && [2,10,12].includes(data.state)) {
				self.vacuum.resumeCleaningZone((err, data) => {
					if (err) {
						res.status(500).send(err.toString());
					} else {
						res.json(data);
					}
				});
			} else {
				self.vacuum.startCleaning((err, data) => {
					if (err) {
						res.status(500).send(err.toString());
					} else {
						res.json(data);
					}
				});
			}
		});
	});

	this.app.put("/api/start_cleaning_only", function (req, res) {
		self.vacuum.startCleaning((err, data) => {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		});
	});

	this.app.put("/api/pause_cleaning", function (req, res) {
		self.vacuum.pauseCleaning(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		});
	});

	this.app.put("/api/stop_cleaning", function (req, res) {
		self.vacuum.stopCleaning(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		});
	});

	this.app.put("/api/set_lab_status", function (req, res) {
		if (req.body && req.body.lab_status !== undefined) {
			self.vacuum.setLabStatus(req.body.lab_status, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.json({message: "ok"});
				}
			})
		} else {
			res.status(400).send("lab_status missing");
		}
	});

	this.app.put("/api/reset_map", function (req, res) {
		self.vacuum.resetMap(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json({message: "ok"});
			}
		});
	});

	this.app.put("/api/store_map", function (req, res) {
	   if (req.body && req.body.name !== undefined) {
			self.mapManager.storeMap(req.body.name, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.json({message: "ok"});
				}
			});
		} else {
			res.status(400).send("name missing");
		}
	});

	this.app.put("/api/load_map", function (req, res) {
		if (req.body && req.body.name !== undefined) {
			self.mapManager.loadMap(req.body.name, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
					return;
				}
				res.json({message: data});
			});
		} else {
			res.status(400).send("name missing");
		}
	});

	this.app.put("/api/remove_map", function (req, res) {
	   if (req.body && req.body.name !== undefined) {
			self.mapManager.removeMap(req.body.name, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.json({message: "ok"});
				}
			});
		} else {
			res.status(400).send("name invalid or missing");
		}
	});

	this.app.get("/api/list_maps", function (req, res) {
		self.mapManager.listStoredMaps(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		});
	});

	this.app.put("/api/go_to", function (req, res) {
		if (req.body && req.body.x !== undefined && req.body.y !== undefined) {
			self.vacuum.goTo(req.body.x, req.body.y, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.json(data);
				}
			})
		} else {
			res.status(400).send("coordinates missing");
		}
	});

	this.app.put("/api/start_cleaning_zone", function (req, res) {
		if (Array.isArray(req.body)) {
			self.vacuum.startCleaningZone(req.body, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.json(data);
				}
			})
		} else {
			res.status(400).send("coordinates missing");
		}
	});

	this.app.put("/api/start_cleaning_zone_by_name", function (req, res) {
		if (Array.isArray(req.body)) {
			let name, zones = [];
			for (let i = 0; i < req.body.length; i++) {
				name = req.body[i];
				let zone = self.configuration.get("areas").find(item => name.toLowerCase() === item[0].toLowerCase());
				if (!zone) {
					return res.status(404).send("zone \"" + name + "\" not found");
				}
				if (!zone[1] || !zone[1].length) {
					return res.status(400).send("zone \"" + name + "\" has no coordinates");
				}
				zones = zones.push(zone[1]);
			};
			self.vacuum.startCleaningZone(zones, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.json(data);
				}
			})
		} else {
			res.status(400).send("zone names missing");
		}
	});

	this.app.get("/api/zones", function (req, res) {
		// Todo: rename areas to zones in config
		const zones = self.configuration.get("areas");

		res.json(zones.map(zone => ({
			name: zone[0],
			coordinates: zone[1]
		})));
	});

	this.app.put("/api/zones", function (req, res) {
		if (req.body && req.body.name && Array.isArray(req.body.coordinates)) {
			// Todo: Extended validation
			let idx, zones = self.configuration.get("areas"),
				newZone = [req.body.name, req.body.coordinates];
			if (req.body.edit) {
				if ((idx = zones.findIndex(zone => zone[0] === req.body.edit)) < 0) {
					return res.status(404).send("zone \"" + req.body.name + "\" not found");
				}
				zones[idx] = newZone;
			} else {
				zones.push(newZone);
			}
			self.configuration.set("areas", zones);
			res.status(201).json({message: "ok"});
		} else {
			res.status(400).send("bad request body");
		}
	});

	this.app.delete("/api/zones/:zoneID", function (req, res) {
		const zones = self.configuration.get("areas");
		let idx = zones.findIndex(zone => zone[0] === req.params.zoneID);
		if (idx < 0) {
			res.status(404).send("No zone with selected id.");
		} else {
			zones.splice(idx, 1);
			self.configuration.set("areas", zones);
			res.status(201).json({message: "ok"});
		}
	});

	this.app.get("/api/spots", function (req, res) {
		const spots = self.configuration.get("spots");

		res.json(spots.map(spot => ({
			name: spot[0],
			coordinates: [spot[1], spot[2]]
		})));
	});

	this.app.put("/api/spots", function (req, res) {
		if (req.body && req.body.name && Array.isArray(req.body.coordinates)) {
			// Todo: Extended validation
			let idx, spots = self.configuration.get("spots"),
				newSpot = [req.body.name, ...req.body.coordinates];
			if (req.body.edit) {
				if ((idx = spots.findIndex(spot => spot[0] === req.body.edit)) < 0) {
					return res.status(404).send("spot \"" + req.body.name + "\" not found");
				}
				spots[idx] = newSpot;
			} else {
				spots.push(newSpot);
			}
			self.configuration.set("spots", spots);
			res.status(201).json({message: "ok"});
		} else {
			res.status(400).send("bad request body");
		}
	});

	this.app.delete("/api/spots/:spotID", function (req, res) {
		const spots = self.configuration.get("spots");
		let idx = spots.findIndex(spot => spot[0] === req.params.spotID);
		if (idx < 0) {
			res.status(404).send("No spot with selected id.");
		} else {
			spots.splice(idx, 1);
			self.configuration.set("spots", spots);
			res.status(201).json({message: "ok"});
		}
	});

	this.app.get("/api/system_config", function (req, res) {
		res.json(self.configuration.get("system"));
	});

	this.app.put("/api/system_config", function (req, res) {
		if (req.body) {
			let config = self.configuration.get("system");
			['afterCleanDest','autoDockReturn', 'mapRestoreType'].forEach(opt => {
				req.body[opt] ? Object.assign(config,{[opt]: req.body[opt]}) : delete config[opt];
			})
			self.configuration.set("system",config);
			res.status(201).json({message: "ok"});
		} else {
			res.status(400).send("bad request body");
		}
	});

	this.app.put("/api/override_queue", function (req, res) {
		if (req.body) {
			if (req.body.gotoSpot !== undefined) {
				self.vacuum.gotoSpotCleaning = true;
				return res.status(201).json({message: "ok"});
			}
			if (req.body.postCleaning !== undefined && (req.body.postCleaning > -1 && req.body.postCleaning < 2 || req.body.postCleaning.x !== undefined && req.body.postCleaning.y !== undefined)) {
				self.vacuum.postCleaningOverride = [req.body.postCleaning.x, req.body.postCleaning.y];
				return res.status(201).json({message: "ok"});
			}
		}
		res.status(400).send("bad parameters");
	});

	this.app.put("/api/start_cleaning_segment", function (req, res) {
		if (Array.isArray(req.body)) {
			self.vacuum.startCleaningSegment(req.body, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.json(data);
				}
			})
		} else {
			res.status(400).send("bad request body");
		}
	});

	this.app.get("/api/segment_names", function (req, res) {
		self.vacuum.getRoomMapping(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		});
	});

	this.app.put("/api/segment_names", function (req, res) {
		if (Array.isArray(req.body)) {
			self.vacuum.nameSegment(req.body, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.json(data);
				}
			});
		} else {
			res.status(400).send("bad request body");
		}
	});

	this.app.put("/api/merge_segment", function (req, res) {
		if (Array.isArray(req.body)) {
			self.vacuum.mergeSegment(req.body, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.json(data);
				}
			});
		} else {
			res.status(400).send("bad request body");
		}
	});

	this.app.put("/api/split_segment", function (req, res) {
		if (Array.isArray(req.body)) {
			self.vacuum.splitSegment(req.body, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.json(data);
				}
			});
		} else {
			res.status(400).send("bad request body");
		}
	});

	this.app.get("/api/autosplit_segments", function (req, res) {
		self.vacuum.manualSegmentMap(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		});
	});

	this.app.get("/api/http_auth_config", function (req, res) {
		res.json({...self.configuration.get("httpAuth"), password: ""});
	});

	this.app.put("/api/http_auth_config", function (req, res) {
		if(req.body && typeof req.body === "object" && typeof req.body.enabled === "boolean" && typeof req.body.username === "string" && typeof req.body.password === "string") {
			pass = req.body.password;
			if (!pass) {
				// Don't set password to empty string, keep old one
				pass = self.configuration.get("httpAuth").password;
			}
			self.configuration.set("httpAuth", {
				enabled: req.body.enabled,
				username: req.body.username,
				password: pass,
			});
			if (self.basicAuthInUse && !req.body.enabled) {
				dynamicAuth.unuse(authMiddleware);
				self.basicAuthInUse = false;
			} else if (!self.basicAuthInUse && req.body.enabled) {
				dynamicAuth.use(authMiddleware);
				self.basicAuthInUse = true;
			}
			res.status(201).json({message: "ok"});
		} else {
			res.status(400).send("bad request body");
		}
	});

	this.app.get("/api/forbidden_markers", function (req, res) {
		const virtualWalls = self.configuration.get("virtualWalls");
		const forbiddenZones = self.configuration.get("forbiddenZones");
		res.json({
			virtual_walls: virtualWalls,
			forbidden_zones: forbiddenZones
		});
	});

	this.app.put("/api/forbidden_markers", function (req, res) {
		if (req.body && Array.isArray(req.body.virtual_walls) && Array.isArray(req.body.forbidden_zones)) {
			self.configuration.set("virtualWalls", req.body.virtual_walls);
			self.configuration.set("forbiddenZones", req.body.forbidden_zones);
			res.status(201).json({message: "ok"});
		} else {
			res.status(400).send("bad request body");
		}
	});

	this.app.put("/api/persistent_data", function (req, res) {
		if (req.body && Array.isArray(req.body.virtual_walls) && Array.isArray(req.body.forbidden_zones)) {
			const persistentData = [
				...req.body.forbidden_zones.map(zone => [0, ...zone]),
				...req.body.virtual_walls.map(wall => [1, ...wall])
			];

			if (self.vacuum.model === 'roborock.vacuum.s5') { //TODO: Move these magic strings to somewhere else
				self.vacuum.savePersistentData(persistentData, function(err) {
					if(err) {
						res.status(500).json(err.toString());
					} else {
						res.status(201).json({message: "ok"});
					}
				});
			} else {
				res.status(501).send("saving persistentData is supported only on Roborock S50/55");
			}
		} else {
			res.status(400).send("bad request body. Should look like { \"virtual_walls\": [], \"forbidden_zones\": []}");
		}
	});

	this.app.put("/api/reboot_device", function (req, res) {
		exec("/sbin/reboot", (err, stdout, stderr) => {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.status(201).json({message: "ok"});
			}
		});
	});

	this.app.put("/api/fanspeed", function (req, res) {
		if (req.body && req.body.speed && req.body.speed <= 105 && req.body.speed >= 0) {
			self.vacuum.setFanSpeed(req.body.speed, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.json(data);
				}
			})
		} else {
			res.status(400).send("Invalid speed");
		}
	});

	this.app.put("/api/set_sound_volume", function (req, res) {
		if (req.body && req.body.volume && req.body.volume <= 100 && req.body.volume >= 0) {
			self.vacuum.setSoundVolume(req.body.volume, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.json(data);
				}
			})
		} else {
			res.status(400).send("Invalid sound volume");
		}
	});

	this.app.get("/api/get_sound_volume", function (req, res) {
		self.vacuum.getSoundVolume(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		});
	});

	this.app.put("/api/test_sound_volume", function (req, res) {
		self.vacuum.testSoundVolume(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		});
	});

	this.app.put("/api/set_ssh_keys", function (req, res) {
		if (!self.configuration.get("allowSSHKeyUpload")) return res.status(403).send("Forbidden");
		if (req.body && req.body.keys && typeof req.body.keys === "string") {
			self.sshManager.setSSHKeys(req.body.keys, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.json(data);
				}
			})
		} else {
			res.status(400).send("Invalid request");
		}
	});

	this.app.get("/api/get_ssh_keys", function (req, res) {
		if (!self.configuration.get("allowSSHKeyUpload")) return res.status(403).send("Forbidden");
		self.sshManager.getSSHKeys(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		});
	});

	this.app.put("/api/ssh_keys_permanently_disable", function (req, res) {
		if (req.body && req.body.confirmation && typeof req.body.confirmation === "string" && req.body.confirmation === "confirm") {
			self.configuration.set("allowSSHKeyUpload", false);
			res.json("success");
		} else {
			res.status(400).send("Invalid request");
		}
	});

	this.app.put("/api/wifi_configuration", function (req, res) {
		if (req.body && req.body.ssid && req.body.password) {
			self.vacuum.configureWifi(req.body.ssid, req.body.password, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.json(data);
				}
			})
		} else {
			res.status(400).send("Invalid wifi configuration");
		}
	});

	this.app.put("/api/reset_consumable", function (req, res) {
		if (req.body && typeof req.body.consumable === "string") {
			self.vacuum.resetConsumable(req.body.consumable, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.json(data);
				}
			})
		} else {
			res.status(400).send("Invalid request");
		}
	});

	this.app.put("/api/find_robot", function (req, res) {
		self.vacuum.findRobot(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		});
	});

	this.app.put("/api/drive_home", function (req, res) {
		self.vacuum.driveHome(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		});
	});

	this.app.put("/api/spot_clean", function (req, res) {
		self.vacuum.spotClean(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		});
	});
	this.app.put("/api/start_manual_control", function (req, res) {
		self.vacuum.startManualControl(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		});
	});

	this.app.put("/api/stop_manual_control", function (req, res) {
		self.vacuum.stopManualControl(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		});
	});

	this.app.put("/api/set_manual_control", function (req, res) {
		if (req.body && req.body.angle !== undefined && req.body.velocity !== undefined
			&& req.body.duration !== undefined && req.body.sequenceId !== undefined) {
			self.vacuum.setManualControl(req.body.angle, req.body.velocity, req.body.duration, req.body.sequenceId, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.json(data);
				}
			});
		}
	});

	this.app.get("/api/get_carpet_mode", function (req, res) {
		self.vacuum.getCarpetMode(function (err, data) {
			if (err) {
				res.status(500).send(err.toString());
			} else {
				res.json(data);
			}
		});
	});

	this.app.put("/api/set_carpet_mode", function (req, res) {
		if (req.body && req.body.enable !== undefined && req.body.current_integral !== undefined && req.body.current_low !== undefined
			&& req.body.current_high !== undefined && req.body.stall_time !== undefined) {
			self.vacuum.setCarpetMode(req.body.enable, req.body.current_integral, req.body.current_low, req.body.current_high, req.body.stall_time, function (err, data) {
				if (err) {
					res.status(500).send(err.toString());
				} else {
					res.json(data);
				}
			});
		}
	});

	this.app.post("/api/install_voice_pack", upload.single('file'), function (req, res) {
		if (req.file){
			//Remove old uploads
			for (const file of fs.readdirSync(self.uploadLocation)) {
				if(file.endsWith(".pkg"))
					fs.unlink(path.join(self.uploadLocation, file), rmerr => {});
			}
			var tmpname = path.join(self.uploadLocation, path.basename(req.file.path) + ".pkg");
			fs.rename(req.file.path, tmpname, function (errFs){
				if(errFs){
					res.status(500).send(errFs.toString());
					fs.unlink(req.file.path, (delerr) => {});
				}else{
					var vps = fs.createReadStream(tmpname);
					var hash = crypto.createHash('md5').setEncoding('hex');
					hash.on('finish', function() {
						self.vacuum.installVoicePack("file://" + tmpname, hash.read(), function (err, data) {
							if (err) {
								res.status(500).send(err.toString());
							} else {
								res.status(200).send(data);
							}
						});
					});

					vps.pipe(hash);

					//Remove the file after 2 minutes
					setTimeout(() => {
						fs.exists(tmpname, (exists) => {
							if(exists){
								fs.unlink(tmpname, (delerr) => {});
							}
						});
					}, 60000);
				}
			});
	   } else {
			res.status(400).send("Invalid request");
	   }
	});

	this.app.get("/api/install_voice_pack_status", function(req, res) {
		self.vacuum.getVoicePackInstallationStatus(function(err, data){
			if(err){
				res.status(500).send(err.toString());
			}else{
				res.status(200).send(data[0]);
			}
		});
	});

	this.app.put("/api/send_update_request", function (req, res) {
		if (req.body && req.body.url !== undefined && req.body.md5 !== undefined && req.body.md5.length === 32) {
			// try to get possibly redirected url since roborock updater requires only direct links and breaks otherwise
			const r = Request(req.body.url);
			new Promise((res,rej) => {
				r.on('response', response => { try { res(response.request.uri.href); } catch (e) { rej(e); }; });
				r.on('error', e => { rej(e); });
			})
			.then(res => (req.body.url = res))
			.catch(_ => null)
			.finally(_ => {
				r.abort();
				console.log(new Date(), "will try to perform updating from " + req.body.url);
				self.events.emit("valetudo.dummycloud.sendUpdateRequest",{url: req.body.url, md5: req.body.md5});
				res.status(200).json({message: "ok"});
			});
		} else {
			res.status(400).send("Invalid parameters");
		}
	});

	this.app.get("/api/token", function (req, res) {
		res.json({
			token: self.vacuum.token.toString("hex")
		});
	});

	this.app.get("/", function (req, res, next) {
		req.url = req.url + 'index.html';
		next();
	});

	this.app.get(/\.(ttf|eot|svg|json|js|html|css)$/, function (req, res, next) {
		const clientPath = path.join(__dirname, "../..", 'client');
		if (fs.existsSync(clientPath + req.url + '.gz')) {
			res.contentType(express.static.mime.lookup(clientPath + req.url));
			res.set('Content-Encoding', 'gzip');
			req.url = req.url + '.gz';
		}
		next();
	});

	this.app.use(express.static(path.join(__dirname, "../..", 'client')));
	const server = http.createServer(this.app);

	const wss = new WebSocket.Server({ server });

	//function to catch alive ws
	function heartbeat() {
		this.isAlive = true;
	}

	function noop() {}

	function prepareStatus(state) {
		let status = Object.assign({}, state);
		status.stateHR = Vacuum.GET_STATE_CODE_DESCRIPTION(status.state);
		if (status.msg_ver === undefined) {
			status.state = 0;
			status.stateHR = "Disconnected";
		}
		status.model = self.vacuum.model;
		if (status.error_code !== undefined) status.errorHR = Vacuum.GET_ERROR_CODE_DESCRIPTION(status.error_code);
		return status;
	}

	self.mapDistributionQueue = [];
	self.mapDistributionCB = [];

	async function mapUploadWorker() {
		while (true) {
			await new Promise((resolve,reject) => {
				if (!self.mapDistributionQueue.length) {
					self.mapDistributionCB.push(resolve);
					return;
				}
				let ws = self.mapDistributionQueue.shift();
				let wst = setTimeout(() => { ws.terminate(); reject(); },5e3); // <-- upload timeout after which this is assumed dead
				ws.send(self.map.bin, () => {
					clearTimeout(wst);
					resolve();
				});
			}).catch(err => {});
		}
	}

	for (let i = 0; i < 4; i++) { // <-- number of simultaneous uploads allowed to run
		mapUploadWorker();
	}

	self.events.on("valetudo.map", () => {
		if (!self.map.bin) return;
		// enqueue map uploads
		wss.clients.forEach(ws => {
			if (!self.mapDistributionQueue.includes(ws)) self.mapDistributionQueue.push(ws);
		});
		// make sleeping workers know that queue has changed
		for (let i = 0; i < self.mapDistributionQueue.length && 0 < self.mapDistributionCB.length; i++) {
			this.mapDistributionCB.shift()();
		}
	});

	self.events.on("miio.status", (status) => {
		// don't need to do anything if there're no clients
		if (!wss.clients.size) return;
		// sending just status updates
		let buf = JSON.stringify({status: prepareStatus(status)});
		wss.clients.forEach(ws => {
			ws.send(buf, noop);
		});
	});

	self.events.on("miio.parametrized_cleaning_failed", () => {
		if (!wss.clients.size) return;
		let buf = JSON.stringify({restoreLocations: true});
		wss.clients.forEach(ws => {
			ws.send(buf, noop);
		});
	});

	setInterval(function() {
		wss.clients.forEach(function each(ws) {
			//terminate inactive ws
			if (ws.isAlive === false) return ws.terminate();

			//mark ws as inactive
			ws.isAlive = false;
			//ask ws to send a pong to be marked as active
			ws.ping(noop);
		});
	}, 30000);

	wss.on("connection", (ws) => {
		//set ws as alive
		ws.isAlive = true;
		//attach pong function
		ws.on("pong", heartbeat);
		ws.on("message", function incoming(message) {
			if (message === "p") ws.send("r", noop);
		});
		ws.send(JSON.stringify({status: prepareStatus(self.cloud.connectedRobot.status)}), noop);
		if (self.map.bin) {
			ws.send(self.map.bin, noop);
		}
	});

	server.listen(this.port, function(){
		console.log(new Date(), "Webserver running on port", self.port)
	});
};

//This is the sole reason why I've bought a 21:9 monitor
WebServer.WIFI_CONNECTED_IW_REGEX = /^Connected to ([0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2})(?:.*\s*)SSID: (.*)\s*freq: ([0-9]*)\s*signal: ([-]?[0-9]* dBm)\s*tx bitrate: ([0-9.]* .*)/;
WebServer.OS_RELEASE_FW_REGEX = /^NAME=(.*)\nVERSION=(.*)\nID=(.*)\nID_LIKE=(.*)\nPRETTY_NAME=(.*)\nVERSION_ID=(.*)\nHOME_URL=(.*)\nSUPPORT_URL=(.*)\nBUG_REPORT_URL=(.*)\n(ROCKROBO|ROBOROCK)_VERSION=(.*)/;

module.exports = WebServer;
