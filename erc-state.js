/**
 * Copyright Seiko Epson Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

const net = require('net');
const iconv = require('iconv-lite');
const EventEmitter = require('events').EventEmitter;

const TERMINATORS = {
  'CR': '\r',
  'LF': '\n',
  'CRLF': '\r\n'
};

// Supported locales and thier respective numbers and encodings for Epson robot controllers
const LOCALES = {
  'en':    { number: 0, encoding: 'Win1252' },
  'ja':    { number: 1, encoding: 'Shift_JIS' },
  'de':    { number: 2, encoding: 'Win1252' },
  'fr':    { number: 3, encoding: 'Win1252' },
  'zh-CN': { number: 4, encoding: 'GB18030' },
  'zh-TW': { number: 5, encoding: 'Big5' }
};

// Error codes and thier respective messages for Remote Ethernet command
const REMOTE_COMMAND_ERR_MSG = {
  '10': 'Remote command does not begin with \'$\'',
  '11': 'Remote command is wrong, or Login is not executed',
  '12': 'Remote command format is wrong',
  '13': 'Login command password is wrong',
  '14': 'Specified number to acquire is out of range (1 or more and 100 or less) or omitted, or specified a string parameter',
  '15': 'Parameter is not existed, or dimension of parameter is wrong, or element out of range is called',
  '19': 'Request time out',
  '20': 'Controller is not ready',
  '21': 'Cannot execute since the Execute is running',
  '98': 'Password is required for Login when using the global IP address',
  '99': 'System error, or communication error'
};

// const ee = new EventEmitter;

/**
 * Robot Controller's state
 */
class EpsonRCState extends EventEmitter {

  
  constructor(host, port, password, terminator, locale) {
    super();
    // Properties used for Remote Ethernet communication
    this.host = host;
    this.port = port;
    this.password = password;
    this.terminator = TERMINATORS[terminator];
    this.locale = {
      number: LOCALES[locale].number,
      encoding: LOCALES[locale].encoding
    };

    // Data store
    this.state = {

      connected: false,
      loggedIn: false,
      locale: locale,
      lastCommand: '',
      lastResponse: '',

      controller: {

        // Basic information
        name: '',
        model: '',
        serial: '',
        firmware: '',

        // Network settings
        network: {
          host: this.host,
          port: this.port,
          address: '',
          subnetMask: '',
          defaultGateway: '',
          macAddress: ''
        },

        // Preferences
        preferences: {},

        // Health conditions
        health: {},

        // Project information
        project: {},

        // Control device
        controlledBy: '',

        // Status
        status: {
          signal: {},
          phase: '',
          errCode: '',
          errMsg: '',
          errFunc: {}
        }
      },

      robots: []
    };

  }

  // Socket connection
  connect() {
    const _this = this;
    _this.socket = new net.Socket();
    try {
      _this.socket.connect(_this.port, _this.host, () => {
        _this.state.connected = true;
        _this.socket.setTimeout(1000*20);
        _this.socket.setNoDelay(true); // Disable the Nagle algorithm to avoid buffering of multiple commands
        _this.state.controller.network.address = _this.socket.remoteAddress;
      });
    } catch (err) {
      _this.state.connected = false;
      throw new Error(err);
    }

    // Basically, event handlers for sockets should be implemented in codes of nodes.

    return;
  }

  // Log in / Log out
  async login() {
    if (this.state.connected && !this.state.loggedIn) {
      await this.command(`$Login,${this.password}`)
        .catch(err => {
          throw err;
        });
    }
  }
  async logout() {
    if (this.state.connected && this.state.loggedIn) {
      await this.command('$Logout')
        .catch(err => {
          throw err;
        })
    }
  }

  // Return a Promise object to send a command, receive and parse the response
  command(cmd) {
    const _this = this;

    if (!_this.state.connected) {
      throw new Error('command() was called but socket not connected');
    }

    const delayRequiredResponses = [
      'GetPrjName',
      'GetRobotInfo',
      'GetContVer',
      'GetForceSerial',
      'GetRobotName',
      'GetRobotSerial',
      'GetHealthCont',
      'GetHealthRB',
      'GetSubnetMask',
      'GetDefaultGateway'
    ];

    return new Promise((resolve, reject) => {

      // Sleep function for specific command (use with async/await)
      function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
      }
      
      try {
        if (delayRequiredResponses.includes(_this.state.lastResponse.split(',')[0].slice(1))) {
          (async () => {
            await sleep(10);
            _this.socket.write(cmd + _this.terminator);
          })();
        } else {
          _this.socket.write(cmd + _this.terminator);
        }
      } catch (err) {
        throw new Error(err);
      }

      _this.state.lastCommand = cmd;

      function gotData(data) {
        resolve(data);
        cleanUp();
        _this.state.lastResponse = iconv.decode(data, _this.locale.encoding).replace(/\r|\n/g, '');
      }

      function gotError(err) {
        reject(err);
        cleanUp();
      }

      // Remove listners
      function cleanUp() {
        _this.socket.removeListener('data', gotData);
        _this.socket.removeListener('error', gotError)
      }

      _this.socket.on('data', gotData);
      _this.socket.on('error', gotError);

    }).then(() => {
      _this._parseResponse(_this.state.lastResponse)
    });
  }

  async exec(queue) {
    const _this = this;
    for (let i=0; i<queue.length; i++) {
      await _this.command(queue[i])
        .catch((err) => {
          throw err;
        });
    }
  }

  // Retrieve parameters from the response string of remote command
  // then set them to related properties
  _parseResponse(res) {
    const _this = this;
    const state = this.state;
    state.lastResponse = res; // Update last response string
    const arr = res.split(','); // Convert to array

    // Check validity of response
    if (!arr[0].startsWith('#')) {
      if (arr[0].startsWith('!')) {
        if (arr[1] === '13' || arr[1] === '98') {
          throw new Error(`Remote command: ${res}: ${REMOTE_COMMAND_ERR_MSG[arr[1]]}`);
        } else
          this.emit('warning', `Remote command: ${res}: ${REMOTE_COMMAND_ERR_MSG[arr[1]]}`);
      } else {
        // throw new Error(`Invalid remote command response: ${res}`);
        this.emit('warning', `Invalid remote command response: ${res}`);
      }
      return;
    }
    
    // Define the object of functions for each response string
    const parsers = {
      '#Login': () => {state.loggedIn = true;},
      '#Logout': () => {state.loggedIn = false;},
      // Responses which contain only a string
      '#GetContName': () => {state.controller.name = arr[1];}, // If controller name is not set, this will be '0'
      '#GetContNo': () => {state.controller.serial = arr[1];},
      '#GetContVer': () => {state.controller.firmware = arr[1].replace(/\s/g, '');}, // Remove space characters since the response contains them after '.'
      '#GetContType': () => {state.controller.model = arr[1];},
      '#GetContDev': () => {state.controller.controlledBy = arr[1];},
      '#GetSubnetMask': () => {state.controller.network.subnetMask = arr[1];},
      '#GetDefaultGateway': () => {state.controller.network.defaultGateway = arr[1];},
      '#GetContMacAdd': () => {state.controller.network.macAddress = arr[1];},
      '#GetCameraModel': () => {state.controller.camera = arr[1];},
      '#GetPrjName': () => {state.controller.project.name = arr[1];},
      '#GetErrMsg': () => {state.controller.status.errMsg = arr[1];},
      // Responses which contain only a number string (converted to number)
      '#GetCurRobot': () => {state.controller.status.currentRobot = Number(arr[1]);},
      '#GetCpuLoad': () => {state.controller.status.cpuLoad = Number(arr[1]);},
      '#GetRobotName': parseGetRobotName.bind(state, arr),
      '#GetRobotSerial': parseGetRobotSerial.bind(state, arr),
      // Responses which require dedicated parsers
      '#GetContSettings': parseGetContSettings.bind(state, arr),
      '#GetHofs': parseGetHofs.bind(state, arr),
      '#GetHealthCont': parseGetHealthCont.bind(state, arr),
      '#GetPartWarning': parseGetPartWarning.bind(state, arr),
      '#GetHealthRB': parseGetHealthRB.bind(state, arr),
      '#GetRobotInfo': parseGetRobotInfo.bind(state, arr),
      '#GetStatus': parseGetStatus.bind(state, arr),
      '#GetErrFunc': parseGetErrFunc.bind(state, arr),
      '#GetMotor': parseGetMotor.bind(state, arr)
    }

    // Call a corresponding parser function
    if (parsers[arr[0]] !== undefined) {
      parsers[arr[0]](arr);
    } else {
      // throw new Error(`Unsupported response: ${res}`)
      this.emit('warning', `Unsupported response: ${res}`);
    }

    function parseGetRobotName (resArr) {
      // We assume only the case that the information of connected robots had already been acquired by $GetRobotInfo,
      // and $GetRobotName was sent with parameter '0' (which means all).
      if (Number(resArr[1]) === state.robots.length) {
        for (let i=0; i<state.robots.length; i++) {
          state.robots[i].name = resArr[i+2];
        }
      } else {
        _this.emit('warning', `Response ${resArr[1]} and number of robots ${state.robots.length} doesn't match.`);
      }
    }

    function parseGetRobotSerial (resArr) {
      // We assume only the case that the information of connected robots had already been acquired by $GetRobotInfo,
      // and $GetRobotSerial was sent with parameter '0' (which means all).
      if (Number(resArr[1]) === state.robots.length) {
        for (let i=0; i<state.robots.length; i++) {
          state.robots[i].serial = resArr[i+2];
        }
      } else {
        _this.emit('warning', `Response ${resArr[1]} and number of robots ${state.robots.length} doesn't match.`);
      }
    }

    function parseGetContSettings (resArr) {
      const pBits = parseInt(resArr[1], 2) // bit string of preferences (Binary)
      state.controller.preferences = {
        resetCommandTurnsOffOutputs:                Boolean(pBits & (1 << 22)),
        outputsOffDuringEmergencyStop:              Boolean(pBits & (1 << 21)),
        allowMotionWithOneOrMoreJointsFree:         Boolean(pBits & (1 << 17)),
        walkStopsForOutputCommands:                 Boolean(pBits & (1 << 18)),
        dryRun:                                     Boolean(pBits & (1 << 20)),
        virtualIO:                                  Boolean(pBits & (1 << 16)),
        includeProjectFilesWhenStatusExported:      Boolean(pBits & (1 << 2)),
        safeguardOpenStopsAllTasks:                 Boolean(pBits & (1 << 15)),
        independentMode:                            Boolean(~(pBits & (1 << 1))),  // This item has the opposite logic of enabled/disabled
        clearGlobalsWhenMainXXFunctionStarted:      Boolean(~(pBits & (1 << 13))), // Also this item
        enableBackgroundTasks:                      Boolean(pBits & (1 << 0)),
        enableAdvancedTaskCommands:                 Boolean(pBits & (1 << 14)),
        enableCpPtpConnectionWhenCpIsOn:            Boolean(pBits & (1 << 19)),
        autoLjm:                                    Boolean(pBits & (1 << 9)),
        disableLjmInTeachMode:                      Boolean(pBits & (1 << 7)),
        disablePointFlagsCheck:                     Boolean(pBits & (1 << 8)),
        motorOffWhenEnableSwitchOffInTeachMode:     Boolean(pBits & (1 << 11)),
        enableRobotMaintenanceData:                 Boolean(pBits & (1 << 6)),
        reversePolarityForForcePowerLowRemoteInput: Boolean(pBits & (1 << 5)),
        tasksArePausedWhenForcePowerLowIsChanged:   Boolean(pBits & (1 << 4)),
        disableT2Test:                              Boolean(pBits & (1 << 3))
      }
    }

    function parseGetHofs (resArr) {
      const robotNum = Number(state.lastCommand.match(/\d/)); // Get robot number from command string which was sent last
      const joints = state.robots[robotNum -1].joints;
      if(isNaN(joints)){
        state.robots[robotNum - 1].hofs = resArr.slice(1).map(el => Number(el)); // Store all acquired values
      }
      else{
        state.robots[robotNum - 1].hofs = resArr.slice(1, (joints+1)).map(el => Number(el)); // Store only same number of elements as joints
      }
    }

    function parseGetHealthCont (resArr) {
      if (resArr[1] === '-1') {
        state.controller.health = {};
      } else {
        // Create properties if undefined
        if (state.controller.health.backupBattery === undefined) {
          state.controller.health.backupBattery = {};
        }
        // Store data
        state.controller.health.backupBattery.installed = Date.parse(dateTimeStringToIso(resArr[1]));
        state.controller.health.backupBattery.consumption = Number(resArr[2]);
        state.controller.health.backupBattery.monthsRemaining = Number(resArr[3]);
      }
    }

    function parseGetPartWarning (resArr) {
      const robotNum = Number(state.lastCommand.match(/\d/));
      state.robots[robotNum - 1].warnings = {
        backupBattery: Boolean(resArr[1] * 1),
        belt:          Boolean(resArr[2] * 1),
        grease:        Boolean(resArr[3] * 1),
        motor:         Boolean(resArr[4] * 1),
        gear:          Boolean(resArr[5] * 1),
        ballScrew:     Boolean(resArr[6] * 1)
      };
    }

    function parseGetHealthRB (resArr) {
      if (resArr[1] === '-1') { // Return immediately if specified part does not exist on specified joint and robot
        return;
      }
      const healthRobotPartTypes = {
        1: 'backupBattery',
        2: 'belt',
        3: 'grease',
        4: 'motor',
        5: 'gear',
        6: 'ballScrew'
      };
      const numbers = state.lastCommand.match(/\d/g).map(el => Number(el)); // Get robot number, part type, and joint number
      let joint; // String: 'joint1'~'joint6' or 'common'. Used as property names
      const partName = healthRobotPartTypes[numbers[1]]; // Get part name used as property name
      const partHealth = {
        installed: Date.parse(dateTimeStringToIso(resArr[1])),
        consumption: Number(resArr[2]),
        monthsRemaining: Number(resArr[3])
      }
      // If the part is Battery, joint string will be 'common', otherwise 'joint${number}'
      numbers[1] === 1 ? joint = 'common' : joint = `joint${numbers[2]}`;

      // Create properties if undefined
      if (state.robots[numbers[0] - 1].health[joint] === undefined) { // Using bracket operator to specify properties by variables
        state.robots[numbers[0] - 1].health[joint] = {};
      }
      if (state.robots[numbers[0] - 1].health[joint][partName] === undefined) {
        state.robots[numbers[0] - 1].health[joint][partName] = {};
      }
      // Store to suitable properties
      state.robots[numbers[0] - 1].health[joint][partName] = partHealth;
    }

    function parseGetRobotInfo (resArr) {
      const robotTypes = {
        '1': 'Joint',
        '2': 'Cartesian',
        '3': 'SCARA',
        '5': '6-axis',
        '6': 'RS-series',
        '7': 'N-series'
      };
      const robots = [];
      const num = Number(resArr[1]);
      for (let i=0; i<num; i++) {
        const model = resArr[i*2+3];
        const series = getSeriesName(model);
        const joints = getJointsNumber(robotTypes[resArr[i*2+2]], model);
        let robot = {
          number: i+1,
          name: '',
          type: robotTypes[resArr[i*2+2]],
          model: model,
          joints: joints,
          series: series,
          serial: '',
          hofs: [],
          warnings: {},
          health: {},
          status: {}
        };
        robots.push(robot);
      }
      state.robots = robots;

      function getSeriesName (model) {
        switch (true) {
          case /^C3/.test(model):
            return 'C3';
          case /^C4-A6/.test(model):
            return 'C4';
          case /^C4-A9/.test(model):
            return 'C4L';
          case /^C8-A7/.test(model):
            return 'C8';
          case /^C8-A9/.test(model):
            return 'C8L';
          case /^C8-A14/.test(model):
            return 'C8XL';
          case /^C12/.test(model):
            return 'C12';
          case /^G10/.test(model): // Check prior to G1
            return 'G10';
          case /^G1/.test(model):  // Check posterior to G10
            return 'G1';
          case /^G3/.test(model):
            return 'G3';
          case /^G6/.test(model):
            return 'G6';
          case /^G20/.test(model):
            return 'G20';
          case /^LS3-\d{1}/.test(model):
            return 'LS3';
          case /^LS3-B/.test(model):
            return 'LS3-B';
          case /^LS6-\d{1}/.test(model):
            return 'LS6';
          case /^LS6-B/.test(model):
            return 'LS6-B';
          case /^LS10-B/.test(model):
            return 'LS10-B';
          case /^LS20-B/.test(model):
            return 'LS20-B';
          case /^LS20-.{1}/.test(model):
            return 'LS20';
          case /^N2/.test(model):
            return 'N2';
          case /^N6-A850/.test(model):
            return 'N6_A850';
          case /^N6-A1000/.test(model):
            return 'N6_A1000';
          case /^RS3/.test(model):
            return 'RS3';
          case /^RS4/.test(model):
            return 'RS4';
          case /^S5/.test(model):
            return 'S5';
          case /^T3/.test(model):
            return 'T3';
          case /^T6/.test(model):
            return 'T6';
          case /^VT6/.test(model):
            return 'VT6';
          case /^X5S/.test(model):
            return 'X5S';
          case /^X5G.{7}A|C$/.test(model):
            return 'X5G_A_D';
          case /^X5G.{7}B|C$/.test(model):
            return 'X5G_B_C';
          case /^X5Z.{7}A$/.test(model):
            return 'X5Z_A';
          case /^X5Z.{7}B$/.test(model):
            return 'X5Z_B';
          case /^X5P.{7}A|D$/.test(model):
            return 'X5P_A_D';
          case /^X5P.{7}B|C$/.test(model):
            return 'X5P_B_C';
          case /^X5U.{7}A|D$/.test(model):
            return 'X5U_A_D';
          case /^X5U.{7}B|C$/.test(model):
            return 'X5U_B_C';
          default:
            return 'Unknown';
        }
      }
  
      function getJointsNumber (type, model) {
        if (type === 'Cartesian') {
          switch (true) {
            case /^X5S/.test(model):
              return 1;
            case /^X5G/.test(model):
            case /^X5Z/.test(model):
              return 2;
            case /^X5P/.test(model):
              return 3;
            case /^X5U/.test(model):
              return 4;
            default:
              return NaN;
          }
        } else if (type === 'SCARA') {
          switch (true) {
            case /^G1-\d{3}.Z$/.test(model):
              return 3;
            default:
              return 4;
          }
        } else if (type === 'RS-series') {
          return 4;
        } else if (type === '6-axis') {
          return 6;
        } else if (type === 'N-series') {
          return 6;
        } else {
          return NaN;
        }
      }

    }
    
    function parseGetStatus (resArr) {
      // Bit masks for status bits
      const READY     = 1 << 0,
            RUNNING   = 1 << 1,
            PAUSED    = 1 << 2,
            ERROR     = 1 << 3,
            ESTOP     = 1 << 4,
            SAFEGUARD = 1 << 5,
            SERROR    = 1 << 6,
            WARNING   = 1 << 7,
            AUTO      = 1 << 8,
            TEACH     = 1 << 9,
            TEST      = 1 << 10;
      let signal = {};
      let phase = '';
      state.controller.status.errCode = resArr[2]; // Error code (String)
      const bits = parseInt(resArr[1], 2); // Bit string of status (Binary)
      // Determine the phase
      switch (bits & (READY | RUNNING | PAUSED)) {
        case 0:
          phase = 'Reset';
          break;
        case 1:
          phase = 'Ready';
          break;
        case 2:
          phase = 'Running';
          break;
        case 4:
          phase = 'Paused';
          break;
        default:
          phase = 'Unknown';
      }
      // Determine the signal
      signal.error         = Boolean(bits & ERROR);
      signal.emergencyStop = Boolean(bits & ESTOP);
      signal.safeguard     = Boolean(bits & SAFEGUARD);
      signal.systemError   = Boolean(bits & SERROR);
      signal.warning       = Boolean(bits & WARNING);
      signal.auto          = Boolean(bits & AUTO);
      signal.teach         = Boolean(bits & TEACH);
      signal.test          = Boolean(bits & TEST);
      // Set properties
      state.controller.status.phase = phase;
      state.controller.status.signal = signal;
      if (state.controller.status.errCode === '0000') {
        state.controller.status.errMsg = '';
        state.controller.status.errFunc = {};
      }
    }

    function parseGetErrFunc (resArr) {
      let errFunc = {};
      if (resArr[1] !== '0') {
        errFunc = {
          name: resArr[1].trim(), // Remove padded spaces (if function name is less than 64 characters, padded with spaces)
          lineNo: Number(resArr[2]),
          taskNo: Number(resArr[3]),
          robotNo: Number(resArr[4]),
          occurred: Date.parse(dateTimeStringToIso(resArr[5]))
        }
      }
      state.controller.status.errFunc = errFunc;
    }

    function parseGetMotor (resArr) {
      // We assume only the case that the information of connected robots had already been acquired by $GetRobotInfo,
      // and $GetMotor was sent with parameter '0' (which means all).
      if (Number(resArr[1]) === state.robots.length) {
        for (let i=0; i<state.robots.length; i++) {
          state.robots[i].status.motorExcitation = Boolean(resArr[i*2+2] * 1);
          state.robots[i].status.powerHigh = Boolean(resArr[i*2+3] * 1);
        }
      } else {
        _this.emit('warning', `Response ${resArr[1]} and number of robots ${state.robots.length} don't match.`);
      }
    }
  }
}

module.exports = EpsonRCState;

function dateTimeStringToIso(str){
  return str.replace(/\//g, '-').replace(' ', 'T') + 'Z';
}
