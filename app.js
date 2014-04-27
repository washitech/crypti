var express = require('express'),
    config = require('./config'),
    routes = require('./routes'),
    db = require('./db.js'),
    async = require('async'),
    blockchain = require('./block').blockchain,
    p2p = require("./p2p"),
    peerNetwork = p2p.peernetwork,
    peerProcessor = p2p.peerprocessor,
    os = require("os"),
    accountprocessor = require("./account").accountprocessor;

var transaction = require('./transactions');

var app = express();

app.configure(function () {
    app.set("version", "0.1");
    app.set("address", config.get("address"));
    app.set('port', config.get('port'));

    var accountProcessor = new accountprocessor(db.db);
    app.use(function (req, res, next) {
        req.db = db.db;
        req.accountprocessor = accountProcessor;
        next();
    });

    app.use(app.router);
});

app.configure("development", function () {
    app.use(express.logger('dev'));
    app.use(express.errorHandler());
});


async.series([
    function (cb) {
        db.initDb(cb);
    },
    function (cb) {
        blockchain.init(db.db, function (err, bc) {
            if (err) {
                cb(err);
            } else {
                cb();
            }
        })
    },
    /*function (cb) {
        var p2pConf = config.get("p2p");
        var pn = new peerNetwork(p2pConf.port, app.get("version"), os.type() + " " + os.platform() + " " + os.arch(), p2pConf.whitelist, new peerProcessor());
        cb();
    }*/
], function (err) {
    if (err) {
        console.log(err);
    } else {
        app.listen(app.get('port'), app.get('address'), function () {
            console.log("Crypti started: " + app.get("address") + ":" + app.get("port"));
            routes(app);
        });
    }
});