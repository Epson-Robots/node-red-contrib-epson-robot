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

 module.exports = function(RED) {
  'use strict';
  const eRC = require('./erc-state');

  // Command queue: only once on successful login (common to old and new firmware)
  const queueOnceCommon = [
    '$GetContName',
    '$GetContNo',
    '$GetContVer', // On old firmware, the controller responds !(11) and we can't acquire the firmware version.
    '$GetRobotInfo'
  ];
  // Command queue: only once on successful login (only for new firmware)
  const queueOnceNewer = [
    '$GetContType',
    '$GetSubnetMask',
    '$GetDefaultGateway',
    '$GetContMacAdd',
    '$GetContSettings',
    '$GetContDev'
  ];
  // Command queue: only once on successful login (only for new firmware and robots are connected)
  const queueOnceNewerAndRobots = [
    '$GetRobotName,0',
    '$GetRobotSerial,0'
  ];
  // Command queue: once a day (only for new firmware)
  // const queueDailyNewer = [
  //   '$GetHealthCont'
  // ];
  // Part set for 4-axis SCARA (To create command queue, prepend '$GetHealthRB,{Robot No.},' for each element)
  const partHealth4AxisScara = [
    '1,1', // Backup Battery (Specified joint number is required by command but unrelated)
    '2,1', // J1 Belt
    '3,1', // J1 Greese
    '4,1', // J1 Motor
    '5,1', // J1 Gear
    '2,2', // J2 Belt
    '3,2', // J2 Greese
    '4,2', // J2 Motor
    '5,2', // J2 Gear 
    '2,3', // J3 Belt
    '3,3', // J3 Greese
    '4,3', // J3 Motor
    '6,3', // J3 Ballscrew
    '2,4', // J4 Belt
    '3,4', // J4 Greese
    '4,4', // J4 Motor
    '5,4', // J4 Gear
  ];
  // Part set for 3-axis SCARA
  const partHealth3AxisScara = [
    '1,1', // Backup Battery (Specified joint number is required by command but unrelated)
    '3,1', // J1 Greese
    '4,1', // J1 Motor
    '5,1', // J1 Gear
    '3,2', // J2 Greese
    '4,2', // J2 Motor
    '5,2', // J2 Gear 
    '2,3', // J3 Belt
    '3,3', // J3 Greese
    '4,3', // J3 Motor
    '6,3', // J3 Ballscrew
  ];
  // Part set for 6-axis (includes N-series)
  const partHealth6Axis = [
    '1,1', // Backup Battery (Specified joint number is required by command but unrelated)
    '2,1', // J1 Belt
    '3,1', // J1 Greese
    '4,1', // J1 Motor
    '5,1', // J1 Gear
    '2,2', // J2 Belt
    '3,2', // J2 Greese
    '4,2', // J2 Motor
    '5,2', // J2 Gear
    '2,3', // J3 Belt
    '3,3', // J3 Greese
    '4,3', // J3 Motor
    '5,3', // J3 Gear
    '2,4', // J4 Belt
    '3,4', // J4 Greese
    '4,4', // J4 Motor
    '5,4', // J4 Gear
    '2,5', // J5 Belt
    '3,5', // J5 Greese
    '4,5', // J5 Motor
    '5,5', // J5 Gear
    '2,6', // J6 Belt
    '3,6', // J6 Greese
    '4,6', // J6 Motor
    '5,6', // J6 Gear
  ];

  // Command queue: once every specified seconds (common to old and new firmware)
  const queueEverySecondsCommon = [
    '$GetCurRobot',
    '$GetCpuLoad',
    '$GetPrjName',
    '$GetStatus' // Depending on the response, $GetErrMsg and $GetErrFunc (only for new firmware) should be executed
  ];
  // Command queue: once every specified seconds (only for new firmware and robots are connected)
  const queueEverySecondsNewerAndRobots = [
    '$GetMotor,0'
  ];

  function StatusMonitor(n) { // 'n (config)' is configurations on the edit dialog
    RED.nodes.createNode(this, n);
    this.name = n.name;
    this.host = n.host;
    this.port = n.port;
    this.password  = this.credentials.password || '';
    this.terminator = n.terminator;
    this.locale = n.locale;
    this.interval = Number(n.interval);
    this.startOfOperation = n.startOfOperation;
    this.timeoutCountDown = null;
    this.timeoutDaily = null;
    this.timeoutSeconds = null;
    const node = this;

    let isHalfClosed = false;

    // Initial status indication of the node
    node.status({fill: 'red', shape: 'ring', text: 'statusMonitor.status.disconnected'});

    // Create a communicator instance for specified controller
    const rc = new eRC(node.host, node.port, node.password, node.terminator, node.locale);

    node.on('active', () => {
      if (!rc.state.connected) {
        if (node.timeoutCountDown !== null) {
          clearInterval(node.timeoutCountDown);
          node.timeoutCountDown = null;
        }
        if (!rc.socket || !rc.socket.connecting) {
          rc.connect();
          addListener();
          node.log('Operation started');
          node.status({fill: 'blue', shape: 'ring', text: 'statusMonitor.status.connecting'});
        }
      }
    });

    node.on('idle', () => {
      if (rc.state.connected) {
        rc.logout();
        deleteTimer();

        rc.socket.end(() => {
          isHalfClosed = true;
          node.log('Operation stopped');
          rc.socket.destroy();
        });

      } else {
        if (rc.socket && !rc.socket.destroyed) {
          node.log('Operation stopped');
          rc.socket.destroy();
        }
        if (node.timeoutCountDown !== null) {
          node.log('Operation stopped');
          clearInterval(node.timeoutCountDown);
          node.timeoutCountDown = null; 
        }
        node.status({fill: 'red', shape: 'ring', text: 'statusMonitor.status.disconnected'});
        
      }
    });

    node.on('input', function(msg) {
      if (msg.payload === true) {
        node.emit('active');
      } else if (msg.payload === false) {
        node.emit('idle');
      }
    });
    
    rc.on('warning', (arg) => {
      node.warn(arg);
    });

    if (this.startOfOperation === 'active') {
      node.emit('active');
    } else if (this.startOfOperation === 'idle') {
      node.emit('idle');
    }

    function deleteTimer() {
      if (node.timeoutSeconds) {
        clearTimeout(node.timeoutSeconds);
      }
      if (node.timeoutDaily) {
        clearTimeout(node.timeoutDaily);
      }
    }

    function addListener() {
      // Connected
      rc.socket.on('connect', async () => {
        node.log(`Connected to ${node.host}:${node.port}`);
        node.status({fill: 'green', shape: 'dot', text: 'statusMonitor.status.connected'});

        let queueOnceOpt= [];
        let queueDaily = [];
        let queueEverySeconds = [].concat(queueEverySecondsCommon);
        let prevPhase = '';
        let queueErr = [];
        let dailyJobPerformedAt = null;

        try {
          await rc.login();
          await rc.exec(queueOnceCommon).then(() => {
            // Create command queues dynamically depending on firmware version and connected robots
            // Only if new firmware...
            if (rc.state.controller.firmware !== '') {
              queueOnceOpt = queueOnceOpt.concat(queueOnceNewer);
              // (New firmware and) if connected robots exist...
              if (rc.state.robots.length) {
                queueOnceOpt = queueOnceOpt.concat(queueOnceNewerAndRobots);
                queueEverySeconds = queueEverySeconds.concat(queueEverySecondsNewerAndRobots);
                for (let i=0; i<rc.state.robots.length; i++) {
                  queueOnceOpt.push(`$GetHofs,${i+1}`);
                }
              }
            }
          });
          await rc.exec(queueOnceOpt).then(() => {
            if (rc.state.controller.firmware !== '') {
              if (rc.state.controller.preferences.enableRobotMaintenanceData) {
                queueDaily.push("$GetHealthCont")
              }
              for (let i=0; i<rc.state.robots.length; i++) {
                queueDaily.push(`$GetPartWarning,${i+1}`)
                if (rc.state.controller.preferences.enableRobotMaintenanceData) {
                  // Push commands about health status of robot parts to the daily command queue
                  // if the setting is enabled
                  switch (rc.state.robots[i].type) {
                    case 'SCARA':
                    case 'RS-series':
                      if (rc.state.robots[i].joints === 3) {
                        queueDaily = queueDaily.concat(partHealth3AxisScara.map(el => `$GetHealthRB,${i+1},${el}`));
                      } else if (rc.state.robots[i].joints === 4) {
                        queueDaily = queueDaily.concat(partHealth4AxisScara.map(el => `$GetHealthRB,${i+1},${el}`));
                      }
                      break;
                    case '6-axis':
                    case 'N-series':
                      queueDaily = queueDaily.concat(partHealth6Axis.map(el => `$GetHealthRB,${i+1},${el}`));
                      break;
                    case 'Joint':
                    case 'Cartesian':
                      node.warn('Joint or Cartesian type robot was detected for robot number ' + rc.state.robots[i].number + '. Part health data is not available.');
                      break;
                    default:
                      node.warn('Unsupported robot type was detected for robot number ' + rc.state.robots[i].number + '. Part health data is not available.');
                      break;
                  }
                }
              }
            }
          });
          await rc.exec(queueDaily)
            .then(() => {
              dailyJobPerformedAt = Date.now();
            });
          await rc.exec(queueEverySeconds)
            .then(() => {
              const currentPhase = rc.state.controller.status.phase;
              if (prevPhase !== currentPhase) { // Update node status only if phase is changed
                node.status({fill: 'green', shape: 'dot', text: RED._("statusMonitor.status.connectedWithPhase", {phase: currentPhase})});
                  // This status text won't be localized even if browser locale was changed. See: https://github.com/node-red/node-red/issues/2429
              }
              prevPhase = currentPhase;
              if (rc.state.controller.status.errCode !== '0000') {
                queueErr.push(`$GetErrMsg,${rc.state.controller.status.errCode},${rc.locale.number}`);
                // For new firmware, add $GetErrFunc command
                if (rc.state.controller.firmware !== '') {
                  queueErr.push(`$GetErrFunc,${rc.state.controller.status.errCode}`);
                }
              }
            })
          await rc.exec(queueErr).then(() => {
            jobSchedule(node.interval);
          });

        } catch (err) {
          node.warn(err);
          isHalfClosed = true;
          rc.socket.end();
        }

        function jobSchedule (sec) {
          // Create msg object for output
          let msg = {
            payload: rc.state,
            timestamp: new Date().valueOf()
          };
          // Output
          node.send(msg);

          // Scheduler
          node.timeoutSeconds = setTimeout(async () => {
            queueErr = [];
            if (Date.now() - dailyJobPerformedAt > 86400000) { // Every 24 hours
              await rc.exec(queueDaily);
              dailyJobPerformedAt = Date.now();
            }
            await rc.exec(queueEverySeconds)
              .then(() => {
                const currentPhase = rc.state.controller.status.phase;
                if (prevPhase !== currentPhase) { // Update node status only if phase is changed
                  node.status({fill: 'green', shape: 'dot', text: RED._("statusMonitor.status.connectedWithPhase", {phase: currentPhase})});
                    // This status text won't be localized even if browser locale was changed. See: https://github.com/node-red/node-red/issues/2429
                }
                prevPhase = currentPhase;
                if (rc.state.controller.status.errCode !== '0000') {
                  queueErr.push(`$GetErrMsg,${rc.state.controller.status.errCode},${rc.locale.number}`);
                  // For new firmware, add $GetErrFunc command
                  if (rc.state.controller.firmware !== '') {
                    queueErr.push(`$GetErrFunc,${rc.state.controller.status.errCode}`);
                  }
                }
              });
            await rc.exec(queueErr);

            // Set next second(s) timer
            jobSchedule(sec)
          }, 1000 * sec)
        }

      });

      // If error occurred on socket ...
      rc.socket.on('error', (err) => {
        node.error(err);
        // Delete timeouts
        deleteTimer();
        node.status({fill: 'red', shape: 'ring', text: 'statusMonitor.status.disconnected'});
      });

      rc.socket.on('close', (hadError) => {
        deleteTimer();
        rc.socket.destroy();
        rc.state.loggedIn = false;
        rc.state.connected = false;
        isHalfClosed = false;
        node.status({fill: 'red', shape: 'ring', text: 'statusMonitor.status.disconnected'});
        if (hadError) {
          rc.socket.emit('reconnect');
        }
      });

      rc.socket.on('end', () => {
        deleteTimer();
        if (isHalfClosed) {
          rc.socket.end();
        } else {
          node.log('Disconnected from controller. Trying to reconnect.');
          rc.socket.emit('reconnect');
        }
        isHalfClosed = false;
        rc.state.connected = false;
      });

      function reconnect() {
        const reconnectTimer = 60;
        let countDownTimer = reconnectTimer;
        node.timeoutCountDown = setInterval(() => {
          if (countDownTimer <= 0) {
            clearInterval(node.timeoutCountDown);
            node.timeoutCountDown = null;
            node.status({fill: 'blue', shape: 'ring', text: 'statusMonitor.status.connecting'});
            rc.connect();
            addListener(rc);
          } else {
            node.status({fill: 'yellow', shape: 'ring', text: RED._('statusMonitor.status.reconnectAfterSeconds', {time: countDownTimer})});
              // This status text won't be localized even if browser locale was changed. See: https://github.com/node-red/node-red/issues/2429
          }
          countDownTimer--;  
        }, 1000);
      }

      node.on('close', function(removed, done) {
        // Delete timeouts
        deleteTimer();
        clearInterval(node.timeoutCountDown);
        node.timeoutCountDown = null;
        isHalfClosed = true;
        rc.socket.end();
        rc.socket.destroy();
        done();
      });

      rc.socket.on('reconnect', () => {
        isHalfClosed = true;
        rc.socket.end();
        reconnect();
      });

      rc.socket.on('timeout', () => {
        node.error('Socket timeout');
        deleteTimer();
        rc.socket.emit('reconnect');
      });
    }

  }

  RED.nodes.registerType('status-monitor', StatusMonitor, {
    credentials: {
      password: { type: "password" }
    }
  })
}
