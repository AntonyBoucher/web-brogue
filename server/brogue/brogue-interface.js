// Class owns communication with a single? brogue socket
// Needs a wrapper class to control its lifecycle then

var events = require('events');
var unixdgram = require('unix-dgram');
var childProcess = require('child_process');
var path = require('path');
var fs = require('fs');

var config = require('../config');
var brogueConstants = require('./brogue-constants.js');

var SERVER_SOCKET = 'server-socket';
var CLIENT_SOCKET = 'client-socket';

var CELL_MESSAGE_SIZE = 10;

var EVENT_BYTE_FLAG = 254;
var EVENT_DATA_OFFSET = 2;
var EVENT_DATA_LENGTH = 100;

var STATUS_BYTE_FLAG = 255;
var STATUS_DATA_OFFSET = 2;

var MOUSE_INPUT_SIZE = 5;
var KEY_INPUT_SIZE = 5;

var SCREEN_REFRESH = 50;

var IDLE_KILLER_INTERVAL = 1 * 24 * 60 * 60 * 1000;
var IDLE_KILLER_TIMEOUT = 14 * 24 * 60 * 60 * 1000;

function BrogueInterface(username) {
    this.username = username;
    this.dataRemainder = new Buffer(0);
    this.brogueEvents = new events.EventEmitter();

    this.disconnected = false;
}

BrogueInterface.prototype.addDataListener = function(listener) {
    this.brogueEvents.on('data', listener);
};

BrogueInterface.prototype.addQuitListener = function(listener) {
    this.brogueEvents.on('quit', listener);
};

BrogueInterface.prototype.addErrorListener = function(listener) {
    this.brogueEvents.on('error', listener);
};

BrogueInterface.prototype.addStatusListener = function(listener) {
    this.brogueEvents.on('status', listener);
};

BrogueInterface.prototype.addEventListener = function(listener) {
    this.brogueEvents.on('event', listener);
};

BrogueInterface.prototype.removeDataListener = function(listener) {
    this.brogueEvents.removeListener('data', listener);
};

BrogueInterface.prototype.removeStatusListener = function(listener) {
    this.brogueEvents.removeListener('status', listener);
};

BrogueInterface.prototype.removeQuitListener = function(listener) {
    this.brogueEvents.removeListener('quit', listener);
};

BrogueInterface.prototype.removeErrorListener = function(listener) {
    this.brogueEvents.removeListener('error', listener);
};

BrogueInterface.prototype.removeEventListener = function(listener) {
    this.brogueEvents.removeListener('event', listener);
};

BrogueInterface.prototype.sendRefreshScreen = function(callback) {

    var messageArray = new Buffer(5);
    messageArray[0] = SCREEN_REFRESH;
    this.sendToBrogue(messageArray, callback);
};

BrogueInterface.prototype.sendToBrogue = function(message, callback) {

    //Send message to socket, if connected
    var messageLength = message.length;

    if (this.brogueSocket) {
        this.brogueSocket.send(message, 0, messageLength, this.getChildWorkingDir() + "/" + SERVER_SOCKET);
        if(callback) {
            callback(null);
        }
    }
    else {
        if(callback) {
            callback(new Error("Socket not connected"));
        }
    }
};

BrogueInterface.prototype.handleIncomingBinaryMessage = function(message, callback) {

    //Movement command from browser

    var controlValue = message.readUInt8(0);
    var messageLength = message.length;
    var ctrlCheck;
    var shiftCheck;
    var isValid;

    if (controlValue === 0) { // key input
        ctrlCheck = message.readUInt8(3);
        shiftCheck = message.readUInt8(4);
        isValid = (messageLength === KEY_INPUT_SIZE) &&
            (ctrlCheck === 0 || ctrlCheck === 1) &&
            (shiftCheck === 0 || shiftCheck === 1);
    }
    else if (controlValue >= 1 && controlValue <= 5) { // mouse input
        ctrlCheck = message.readUInt8(3);
        shiftCheck = message.readUInt8(4);
        isValid = (messageLength === MOUSE_INPUT_SIZE) &&
            (ctrlCheck === 0 || ctrlCheck === 1) &&
            (shiftCheck === 0 || shiftCheck === 1);
    }

    if (!isValid) {
        callback(new Error("Invalid mouse or key input: " + JSON.stringify(message)));
        return;
    }

    this.sendToBrogue(message, callback);
};


BrogueInterface.prototype.getChildWorkingDir = function () {
    return config.path.GAME_DATA_DIR + this.username;
},


BrogueInterface.prototype.start = function (data, reconnectOnly) {

    //Support reconnect

    //Test if we can send to server socket, if so, no need to spawn a new process, just attach
    //This may happen on first connect after server restart, for example

    try {

        var sendBuf = new Buffer(5);
        sendBuf[0] = SCREEN_REFRESH;

        this.brogueSocket = unixdgram.createSocket('unix_dgram');

        this.brogueSocket.send(sendBuf, 0, 5, this.getChildWorkingDir() + "/" + SERVER_SOCKET, function () {
            //ok to connect to socket - callback
        });

        //Okay to connect through socket to running process
        this.attachChildProcess();
    }
    catch(e) {

        //If the game doesn't exist, and we are trying to play (not observe),
        //create a new game

        if(this.brogueSocket != null) {
            this.brogueSocket.close();
        }

        if(!reconnectOnly) {
            this.newBrogueProcess(data);
        }
        else {
            throw e;
        }
    }
};

BrogueInterface.prototype.newBrogueProcess = function(data) {

    var childWorkingDir = this.getChildWorkingDir();
    var args = ["--no-menu", "--no-recording", "--no-scores", "--no-saves"]; // the flames on the brogue menu will crash most clients since it sends too much data at once

    //Input has been sanity checked in the controller. Any errors from brogue should be caught by the usual handlers
    if (data) {
        if (data.savedGame) {

            args.push("-o");
            args.push(data.savedGame);
        }
        else if (data.seed || data.seed === "") {
            var seed = parseInt(data.seed, 10);

            args.push("-s");
            args.push(seed);
        }
    }

    this.spawnChildProcess(args, childWorkingDir);
};

BrogueInterface.prototype.spawnChildProcess = function (args, childWorkingDir) {
    var options = {
        cwd: childWorkingDir,
        detached: true,
        stdio: 'ignore'
    };
    this.brogueChild = childProcess.spawn(config.path.BROGUE, args, options);
    this.attachChildProcess();
};

BrogueInterface.prototype.attachChildProcess = function() {
    this.attachChildEvents();
    this.attachChildIdleKiller();
};

BrogueInterface.prototype.attachChildIdleKiller = function() {
    this.intervalKiller = setInterval(this.checkIdleTimeAndKill.bind(this), IDLE_KILLER_INTERVAL);
};

BrogueInterface.prototype.checkIdleTimeAndKill = function() {
    var idleTime = new Date().getTime() - this.lastActiveTime;

    if(idleTime > IDLE_KILLER_TIMEOUT) {
        clearTimeout(this.intervalKiller);

        this.killBrogue(this);
        this.disconnectBrogue(this);

        //Do not send the 'error' event, since it's likely that no controller is listening any more, and the 'error' event will crash the server
        this.brogueEvents.emit('quit', 'Brogue process timed out due to inactivity');
    }
};

BrogueInterface.prototype.attachChildEvents = function () {

    var self = this;

    try { fs.unlinkSync(this.getChildWorkingDir() + "/" + CLIENT_SOCKET); } catch (e) { /* swallow */ }

    var client_read = unixdgram.createSocket('unix_dgram');
    client_read.on('message', function(data, rinfo) {

        //Callback when receiving data on the socket from brogue

        //console.error('data: (%d, %d) -> %s', data[0], data[1], String.fromCharCode(data[3]));

        //Speed debugging
        //var d = new Date();
        //console.error(d.getTime());

        self.lastActiveTime = new Date().getTime();

        // Ensure that we send out data in chunks divisible by CELL_MESSAGE_SIZE and save any left over for the next data event
        // While it would be more efficient to accumulate all the data here on the server, I want the client to be able to start processing this data as it is being returned.
        var dataLength = data.length;

        //console.error(dataLength);

        var remainderLength = self.dataRemainder.length;
        var numberOfCellsToSend = (dataLength + remainderLength) / CELL_MESSAGE_SIZE | 0;  // |0 is still 2x faster than Math.floor or parseInt
        var sizeOfCellsToSend = numberOfCellsToSend * CELL_MESSAGE_SIZE;
        var newReminderLength = dataLength + remainderLength - sizeOfCellsToSend;

        //fill the data to send
        self.dataAccumulator = new Buffer(sizeOfCellsToSend);
        self.dataRemainder.copy(self.dataAccumulator);
        data.copy(self.dataAccumulator, remainderLength, 0, dataLength - newReminderLength);

        //save the remaining data for next time
        self.dataRemainder = new Buffer(newReminderLength);
        data.copy(self.dataRemainder, 0, dataLength - newReminderLength, dataLength);

        //check for status updates in data and update user object.
        var i = 0;
        while(i < sizeOfCellsToSend) {
            if (self.dataAccumulator[i] === STATUS_BYTE_FLAG){
                var updateFlag = self.dataAccumulator[i + STATUS_DATA_OFFSET];

                // We need to send 4 bytes over as unsigned long.  JS bitwise operations force a signed long, so we are forced to use a float here.
                var updateValue =
                    self.dataAccumulator[i + STATUS_DATA_OFFSET + 1] * 16777216 +
                    self.dataAccumulator[i + STATUS_DATA_OFFSET + 2] * 65536 +
                    self.dataAccumulator[i + STATUS_DATA_OFFSET + 3] * 256 +
                    self.dataAccumulator[i + STATUS_DATA_OFFSET + 4];

                self.brogueEvents.emit('status', {flag: updateFlag, value: updateValue});

                //Remove this status update from the dataAccumulator
                if(i + CELL_MESSAGE_SIZE <= self.dataAccumulator.length) {
                    self.dataAccumulator.copy(self.dataAccumulator, i, i + CELL_MESSAGE_SIZE);
                    self.dataAccumulator = self.dataAccumulator.slice(0, self.dataAccumulator.length - CELL_MESSAGE_SIZE);
                }
                else {
                    i += CELL_MESSAGE_SIZE;
                }
            }
            else if(self.dataAccumulator[i] === EVENT_BYTE_FLAG) {
                var eventId = self.dataAccumulator[i + EVENT_DATA_OFFSET];

                // We need to send bytes over as unsigned long.  JS bitwise operations force a signed long, so we are forced to use a float here.
                var eventData1 =
                    self.dataAccumulator[i + EVENT_DATA_OFFSET + 1] * 256 +
                    self.dataAccumulator[i + EVENT_DATA_OFFSET + 2];

                var eventData2 =
                    self.dataAccumulator[i + EVENT_DATA_OFFSET + 3] * 256 +
                    self.dataAccumulator[i + EVENT_DATA_OFFSET + 4];

                var level =
                    self.dataAccumulator[i + EVENT_DATA_OFFSET + 5] * 256 +
                    self.dataAccumulator[i + EVENT_DATA_OFFSET + 6];

                var easyMode =
                    self.dataAccumulator[i + EVENT_DATA_OFFSET + 7] * 256 +
                    self.dataAccumulator[i + EVENT_DATA_OFFSET + 8];

                var gold =
                    self.dataAccumulator[i + EVENT_DATA_OFFSET + 9] * 16777216 +
                    self.dataAccumulator[i + EVENT_DATA_OFFSET + 10] * 65536 +
                    self.dataAccumulator[i + EVENT_DATA_OFFSET + 11] * 256 +
                    self.dataAccumulator[i + EVENT_DATA_OFFSET + 12];

                var seed =
                    self.dataAccumulator[i + EVENT_DATA_OFFSET + 13] * 16777216 +
                    self.dataAccumulator[i + EVENT_DATA_OFFSET + 14] * 65536 +
                    self.dataAccumulator[i + EVENT_DATA_OFFSET + 15] * 256 +
                    self.dataAccumulator[i + EVENT_DATA_OFFSET + 16];

                var messageStart = i + EVENT_DATA_OFFSET + 17;
                var eventEnd = i + EVENT_DATA_LENGTH;

                for(var j = messageStart; j < eventEnd; j++) {
                    if(self.dataAccumulator[j] == 0) {
                        break;
                    }
                }

                var messageLength = j - 1;

                var eventStr = self.dataAccumulator.slice(messageStart, messageLength).toString('utf8');

                var eventData = {
                    date: Date.now(),
                    eventId: eventId,
                    data1: eventData1,
                    data2: eventData2,
                    gold: gold,
                    level: level,
                    seed: seed,
                    easyMode: easyMode,
                    message: eventStr
                };

                self.brogueEvents.emit('event', eventData);

                self.processBrogueEvents(self, eventData);

                //Remove this status update from the dataAccumulator
                if (i + EVENT_DATA_LENGTH <= self.dataAccumulator.length) {
                    self.dataAccumulator.copy(self.dataAccumulator, i, i + EVENT_DATA_LENGTH);
                    self.dataAccumulator = self.dataAccumulator.slice(0, self.dataAccumulator.length - EVENT_DATA_LENGTH);
                }
                else {
                    i += EVENT_DATA_LENGTH;
                }
            }
            else {
                //No status message
                i += CELL_MESSAGE_SIZE;
            }
        }

        //Send any remaining data onwards to the console
        self.brogueEvents.emit('data', self.dataAccumulator);
    });

    client_read.on('error', function(err) {
        console.error('Error when reading from client socket' + err);
        //Not identified any cases where this can happen yet but assume it's terminal
        self.disconnectBrogue(self);
        self.brogueEvents.emit('quit', 'Error when reading from client socket');
    });

    client_read.bind(this.getChildWorkingDir() + "/" + CLIENT_SOCKET);

    //Server write socket
    //May have already been connected in the test above
    if(!this.brogueSocket) {
        this.brogueSocket = unixdgram.createSocket('unix_dgram');
    }

    this.brogueSocket.on('error', function(err) {
        console.error('Error when writing to client socket: ' + err);
        //This occurs when we connected to an orphaned brogue process and it exits
        //Therefore we set ourselves into an ended state so a new game can be started
        self.disconnectBrogue(self);

        self.brogueEvents.emit('quit', 'Error when writing to client socket - normally brogue has exited');
    });

    //Not applicable when connecting to an orphaned process
    if(self.brogueChild) {

        self.brogueChild.on('exit', function () {
            // we no longer respond to this event. It sometimes triggers (and causes listeners to be removed)
            // before all events are processed from brogue so reacting here can miss events
        });

        self.brogueChild.on('error', function (err) {
            self.killBrogue(self);
            self.disconnectBrogue(self);

            self.brogueEvents.emit('quit', 'Message could not be sent to brogue process - Error: ' + err);
        });
    }
};

BrogueInterface.prototype.killBrogue = function(self) {
    if(self.brogueChild) {
        self.brogueChild.kill();
    }
};

BrogueInterface.prototype.disconnectBrogue = function(self) {
    self.brogueChild = null;
    self.brogueSocket = null;
    self.disconnected = true;
};

BrogueInterface.prototype.processBrogueEvents = function(self, eventData) {
    //Analyse brogue messages and do suitable processing, before passing back to the controller

    //Kill the brogue process on quit (save a keypress and make sure it dies)
    if(eventData.eventId === brogueConstants.GAMEOVER_QUIT ||
        eventData.eventId === brogueConstants.GAMEOVER_DEATH ||
        eventData.eventId === brogueConstants.GAMEOVER_VICTORY ||
        eventData.eventId === brogueConstants.GAMEOVER_SUPERVICTORY) {

        self.killBrogue(self);
        self.disconnectBrogue(self);
        self.brogueEvents.emit('quit');
    }
};

module.exports = BrogueInterface;
