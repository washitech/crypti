var crypto = require('crypto'),
	bignum = require('bignum'),
	ed = require('ed25519'),
	params = require('../helpers/params.js'),
	shuffle = require('knuth-shuffle').knuthShuffle,
	Router = require('../helpers/router.js'),
	arrayHelper = require('../helpers/array.js'),
	slots = require('../helpers/slots.js'),
	schedule = require('node-schedule');
var strftime = require('strftime');

//private fields
var modules, library, self;

var keypair, myDelegate, address, account;
var delegates = {};
var activeDelegates = [];
var loaded = false;

//constructor
function Delegates(cb, scope) {
	library = scope;
	self = this;

	attachApi();

	setImmediate(cb, null, self);
}

//private methods
function attachApi() {
	var router = new Router();

	router.use(function (req, res, next) {
		if (modules && loaded) return next();
		res.status(500).send({success: false, error: 'loading'});
	});

	router.put('/', function (req, res) {
		var secret = params.string(req.body.secret),
			publicKey = params.string(req.body.publicKey),
			secondSecret = params.string(req.body.secondSecret),
			username = params.string(req.body.username);

		var hash = crypto.createHash('sha256').update(secret, 'utf8').digest();
		var keypair = ed.MakeKeypair(hash);

		if (publicKey) {
			if (keypair.publicKey.toString('hex') != publicKey) {
				return res.json({success: false, error: "Please, provide valid secret key of your account"});
			}
		}

		var account = modules.accounts.getAccountByPublicKey(keypair.publicKey.toString('hex'));

		if (!account) {
			return res.json({success: false, error: "Account doesn't has balance"});
		}

		if (!account.publicKey) {
			return res.json({success: false, error: "Open account to make transaction"});
		}

		var transaction = {
			type: 2,
			amount: 0,
			recipientId: null,
			senderPublicKey: account.publicKey,
			timestamp: slots.getTime(),
			asset: {
				delegate: {
					username: username
				},
				votes: []
			}
		};

		modules.transactions.sign(secret, transaction);

		if (account.secondSignature) {
			if (!secondSecret || secondSecret.length == 0) {
				return res.json({success: false, error: "Provide second secret key"});
			}

			modules.transactions.secondSign(secondSecret, transaction);
		}

		modules.transactions.processUnconfirmedTransaction(transaction, true, function (err) {
			if (err) {
				return res.json({success: false, error: err});
			}

			res.json({success: true, transaction: transaction});
		});
	});

	library.app.use('/api/delegates', router);
	library.app.use(function (err, req, res, next) {
		if (!err) return next();
		library.logger.error('/api/delegates', err)
		res.status(500).send({success: false, error: err});
	});
}

function getKeysSortByVote() {
	var delegatesArray = arrayHelper.hash2array(delegates);
	delegatesArray = delegatesArray.sort(function compare(a, b) {
		return (b.vote || 0) - (a.vote || 0);
	})
	var justKeys = delegatesArray.map(function (v) {
		return v.publicKey;
	});
	return justKeys;
}

function getShuffleVotes() {
	var delegatesIds = getKeysSortByVote();
	var final = delegatesIds.slice(0, 33);
	return shuffle(final);
}

function forAllVote() {
	return [];
}

function getBlockTime(slot, height, delegateCount) {
	activeDelegates = getActiveDelegates(height, delegateCount);

	var currentSlot = slot;
	var lastSlot = slots.getLastSlot(currentSlot);

	for (; currentSlot < lastSlot; currentSlot += 1) {
		var delegate_pos = currentSlot % delegateCount;
		var delegate_id = activeDelegates[delegate_pos];
		if (delegate_id && myDelegate.publicKey == delegate_id) {
			return slots.getSlotTime(currentSlot);
		}
	}
	return null;
}

function loop(cb) {
	if (!myDelegate || !account) {
		library.logger.log('loop', 'exit: no delegate');
		return setImmediate(cb);
	}

	if (!loaded || modules.loader.syncing()) {
		library.logger.log('loop', 'exit: syncing');
		return setImmediate(cb);
	}

	debugger;
	var currentSlot = slots.getSlotNumber();
	var lastBlock = modules.blocks.getLastBlock();

	if (currentSlot == slots.getSlotNumber(lastBlock.timestamp)) {
		library.logger.log('loop', 'exit: lastBlock is in the same slot');
		return setImmediate(cb);
	}

	var currentBlockTime = getBlockTime(currentSlot, lastBlock.height, slots.delegates);

	if (currentBlockTime === null) {
		library.logger.log('loop', 'skip slot');
		return setImmediate(cb);
	}

	setImmediate(cb);

	console.log(currentSlot, lastBlock.height, lastBlock.id, activeDelegates.map(function (id) {
		return id.substring(0, 4);
	}))

	library.sequence.add(function (cb) {
		if (slots.getSlotNumber(currentBlockTime) == slots.getSlotNumber()) {
			library.logger.log('loop', 'generate in slot: ' + slots.getSlotNumber(currentBlockTime));
			modules.blocks.generateBlock(keypair, currentBlockTime, cb);
		} else {
			library.logger.log('loop', 'exit: another delegate slot');
			setImmediate(cb);
		}
	}, function (err) {
		if (err) {
			library.logger.error("Problem in block generation", err);
		}
	});
}

function loadMyDelegates() {
	var secret = library.config.forging.secret

	if (secret) {
		keypair = ed.MakeKeypair(crypto.createHash('sha256').update(secret, 'utf8').digest());
		address = modules.accounts.getAddressByPublicKey(keypair.publicKey.toString('hex'));
		account = modules.accounts.getAccount(address);
		myDelegate = self.getDelegate(keypair.publicKey.toString('hex'));

		library.logger.info("Forging enabled on account: " + address);
	}
}

function getActiveDelegates(height, delegateCount) {
	var count = height - 1;
	if (!activeDelegates.length || count % delegateCount == 0) {
		var seedSource = height.toString();
		var delegateIds = getKeysSortByVote();
		var currentSeed = crypto.createHash('sha256').update(seedSource, 'utf8').digest();
		for (var i = 0, delCount = delegateIds.length; i < delCount; i++) {
			for (var x = 0; x < 4 && i < delCount; i++, x++) {
				var newIndex = currentSeed[x] % delCount;
				var b = delegateIds[newIndex];
				delegateIds[newIndex] = delegateIds[i];
				delegateIds[i] = b;
			}
			currentSeed = crypto.createHash('sha256').update(currentSeed).digest();
		}

	}
	return delegateIds;
}

//public methods
Delegates.prototype.getVotesByType = function (votingType) {
	if (votingType == 1) {
		return forAllVote();
	} else if (votingType == 2) {
		return getShuffleVotes();
	} else {
		return null;
	}
}

Delegates.prototype.checkVotes = function (votes) {
	if (votes.length == 0) {
		return true;
	} else {
		votes.forEach(function (publicKey) {
			if (!delegates[publicKey]) {
				return false;
			}
		});

		return true;
	}
}

Delegates.prototype.voting = function (publicKeys, amount) {
	amount = amount || 0
	if (publicKeys.length > 33) {
		publicKeys = publicKeys.slice(0, 33);
	}
	if (publicKeys.length == 0) {
		Object.keys(delegates).forEach(function (publicKey) {
			if (delegates[publicKey]) {
				delegates[publicKey].vote = (delegates[publicKey].vote || 0) + amount;
			}
		});
	} else {
		publicKeys.forEach(function (publicKey) {
			if (delegates[publicKey]) {
				delegates[publicKey].vote = (delegates[publicKey].vote || 0) + amount;
			}
		});
	}
}

Delegates.prototype.getDelegate = function (publicKey) {
	return delegates[publicKey];
}

Delegates.prototype.cache = function (delegate) {
	delegates[delegate.publicKey] = delegate;
	slots.delegates = Math.min(101, Object.keys(delegates).length)
}

Delegates.prototype.uncache = function (delegate) {
	delete delegates[delegate.publicKey];
	slots.delegates = Math.min(101, Object.keys(delegates).length)
}

Delegates.prototype.validateBlockSlot = function (block, cb) {
	library.dbLite.query("select count(*) from blocks b inner join trs t on b.id = t.blockId and t.type = 2 where b.height <= $height", {height: block.height}, {"count": Number}, function (err, rows) {
		if (err || !rows.length) {
			return cb(err || 'delegates not found');
		}
		var delegateCount = rows[0].count;

		var activeDelegates = getActiveDelegates(block.height, delegateCount);

		var currentSlot = slots.getSlotNumber(block.timestamp);
		var delegate_id = activeDelegates[currentSlot % delegateCount];
		if (delegate_id && block.generatorPublicKey == delegate_id) {
			return cb(null, true);
		}

		cb(null, false);
	});
}

//events
Delegates.prototype.onBind = function (scope) {
	modules = scope;
}

Delegates.prototype.onBlockchainReady = function () {
	loaded = true;

	loadMyDelegates(); //temp

	process.nextTick(function nextLoop() {
		loop(function (err) {
			err && library.logger.error('delegate loop', err);

			var nextSlot = slots.getNextSlot();

			var scheduledTime = slots.getSlotTime(nextSlot);
			scheduledTime = scheduledTime <= slots.getTime() ? scheduledTime + 1 : scheduledTime;
			schedule.scheduleJob(new Date(slots.getRealTime(scheduledTime) + 1000), nextLoop);
		})
	});
}

Delegates.prototype.onReceiveBlock = function () {
	if (keypair) {
		myDelegate = self.getDelegate(keypair.publicKey.toString('hex'));
	}
}

//export
module.exports = Delegates;