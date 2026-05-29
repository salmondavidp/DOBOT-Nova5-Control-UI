let ws = null;
        let reconnectTimer = null;
        let isTerminating = false;
        let hasFault = true;
        let isEnabled = false;
        let selectedMode = 8; // CSP default
        let isTemplateRunning = false; // Track if template is running
        let isFirstStatus = true; // Flag to restore state on reconnect

        // Cache for status updates to avoid unnecessary DOM changes
        let lastStatusStateKey = null;
        let lastStatusMode = null;
        let lastNumSlaves = null;
        let lastInterface = null;
        let lastFaultState = null;
        let lastMovingState = null;

        // Template step timing tracking
        let stepTimings = {};  // { stepIndex: { startTime, endTime, elapsed } }
        let currentStepIndex = null;
        let stepTimerInterval = null;

        // Loop test state
        let loopTestRunning = false;
        let loopTestCurrentCycle = 0;
        let loopTestTargetCycles = 0;
        let loopTestDirection = 'forward';  // 'forward' or 'backward'
        let loopTestCheckInterval = null;
        let loopTestDelayTimer = null;
        let loopTestDelayRemaining = 0;
        let loopTestSelectedSlave = null;

        // Multi-slave loop test state
        let multiLoopRunning = false;
        let multiLoopSelectedSlaves = new Set();  // Set of selected slave indices
        let multiLoopSlaveStatus = {};  // { slaveIdx: 'idle'|'moving'|'wait'|'done' }
        let multiLoopSlaveDelay = {};  // { slaveIdx: { start: timestamp, duration: seconds } }
        let multiLoopDelayInterval = null;  // Interval for updating delay display

        // Interface selection overlay state
        let disconnectedCounter = 0;
        let interfaceOverlayShown = false;

        // ========================================================
        // LocalStorage Cache - persist UI state across page reloads
        // ========================================================
        const CACHE_KEY = 'newui_state';

        function saveStateCache() {
            try {
                const cfg = (typeof loadedConfig !== 'undefined') ? loadedConfig : null;
                const state = {
                    selectedMode,
                    loadedConfig: cfg,
                    isTemplateRunning,
                    selectedConfigFilename: document.getElementById('configFileName')?.value || ''
                };
                localStorage.setItem(CACHE_KEY, JSON.stringify(state));
            } catch (e) { /* ignore storage errors */ }
        }

        function restoreFromCache() {
            try {
                const raw = localStorage.getItem(CACHE_KEY);
                if (!raw) return false;
                const cached = JSON.parse(raw);
                if (!cached) return false;

                // Restore mode (prevents CSP default flash)
                if (cached.selectedMode && [1, 3, 8].includes(cached.selectedMode)) {
                    selectedMode = cached.selectedMode;
                    lastStatusMode = cached.selectedMode; // Prevent backend from overwriting
                    // Update mode selector UI
                    const modeNames = {1: 'PP', 3: 'PV', 8: 'CSP'};
                    const modeName = modeNames[selectedMode] || selectedMode;
                    const modeLabel = document.getElementById('modeLabel');
                    if (modeLabel) modeLabel.textContent = modeName;
                    document.querySelectorAll('.mode-item').forEach(el => {
                        el.classList.toggle('active', parseInt(el.dataset.mode) === selectedMode);
                    });
                    const opModeLabel = document.getElementById('operationModeLabel');
                    if (opModeLabel) opModeLabel.textContent = `(${modeName} Mode)`;
                    showCorrectModeActions();
                }

                // Restore loaded config and template table
                if (cached.loadedConfig && typeof updateConfigInfo === 'function') {
                    updateConfigInfo(cached.loadedConfig);
                }

                // Restore template running state (will be validated by first status)
                if (cached.isTemplateRunning) {
                    isTemplateRunning = true;
                    if (typeof updateTemplateControlsState === 'function') {
                        updateTemplateControlsState();
                    }
                }

                // Restore selected config filename in dropdown
                if (cached.selectedConfigFilename) {
                    const select = document.getElementById('configFileName');
                    if (select) {
                        // Will be set properly after config list loads; store for later
                        select.dataset.pendingValue = cached.selectedConfigFilename;
                    }
                }

                return true;
            } catch (e) { return false; }
        }

        // Toggle info tooltip
        function toggleInfoTooltip() {
            const content = document.getElementById('infoTooltipContent');
            content.classList.toggle('show');
            // Close comm tooltip when opening info
            document.getElementById('commTooltipContent').classList.remove('show');
        }

        // Toggle communication tooltip
        function toggleCommTooltip() {
            const content = document.getElementById('commTooltipContent');
            content.classList.toggle('show');
            // Close info tooltip when opening comm
            document.getElementById('infoTooltipContent').classList.remove('show');
        }

        // Communication UDP functions (global)
        function commUdpConnect() {
            const ip = document.getElementById('commUdpIp').value;
            const port = parseInt(document.getElementById('commUdpPort').value);
            sendCmd('udp_connect', { ip: ip, port: port });
            log(`Connecting UDP: ${ip}:${port}`, 'com');
        }

        function commUdpDisconnect() {
            sendCmd('udp_disconnect');
            log('Disconnecting UDP', 'com');
        }

        function setUdpMode(mode) {
            sendCmd('set_udp_mode', { mode: mode });
            const name = mode === 0 ? 'Position (slave,pos)' : 'Duration (slave,sec,dir)';
            log(`UDP mode: ${name}`, 'com');
        }

        function updateCommUdpStatus(connected) {
            const dot = document.getElementById('commUdpStatusDot');
            const text = document.getElementById('commUdpStatusText');
            const connectBtn = document.getElementById('commUdpConnectBtn');
            const disconnectBtn = document.getElementById('commUdpDisconnectBtn');

            if (connected) {
                dot.className = 'status-dot connected';
                text.textContent = 'Connected';
                connectBtn.disabled = true;
                disconnectBtn.disabled = false;
            } else {
                dot.className = 'status-dot disconnected';
                text.textContent = 'Disconnected';
                connectBtn.disabled = false;
                disconnectBtn.disabled = true;
            }
        }

        // Communication OSC functions (global)
        async function commOscConnect() {
            const sendIp = document.getElementById('commOscSendIp').value;
            const sendPort = parseInt(document.getElementById('commOscSendPort').value);
            const recvIp = document.getElementById('commOscRecvIp').value;
            const recvPort = parseInt(document.getElementById('commOscRecvPort').value);
            const modeRadio = document.querySelector('input[name="commOscMode"]:checked');
            const mode = modeRadio ? parseInt(modeRadio.value) : 3;
            const sendMovement = document.getElementById('commOscSendMovement').checked;
            const sendTemplate = document.getElementById('commOscSendTemplate').checked;
            const sendClipConnect = document.getElementById('commOscSendClipConnect').checked;

            // Persist receiver settings to osclistner.json
            await saveOscListenerReceiver(recvIp, recvPort);

            sendCmd('osc_connect', {
                send_ip: sendIp,
                send_port: sendPort,
                recv_ip: recvIp,
                recv_port: recvPort,
                mode: mode,
                send_movement: sendMovement,
                send_template: sendTemplate,
                send_clip_connect: sendClipConnect
            });
            const modeNames = {1: 'Receive', 2: 'Send', 3: 'Both'};
            let addrInfo = sendMovement ? ' [/movement]' : '';
            addrInfo += sendTemplate ? ' [/template_step]' : '';
            addrInfo += sendClipConnect ? ' [/clips/{v}/connect]' : '';
            log(`Starting OSC (${modeNames[mode]}): Recv ${recvIp}:${recvPort}, Send ${sendIp}:${sendPort}${addrInfo}`, 'com');
        }

        function commOscDisconnect() {
            sendCmd('osc_disconnect');
            log('Stopping OSC', 'com');
        }

        async function loadOscListenerReceiver() {
            try {
                const resp = await fetch('/api/osc_listener');
                const cfg = await resp.json();
                const receiver = (cfg && cfg.receiver) ? cfg.receiver : {};
                if (receiver.ip) document.getElementById('commOscRecvIp').value = receiver.ip;
                if (receiver.port) document.getElementById('commOscRecvPort').value = receiver.port;
            } catch (e) {
                // ignore load errors
            }
        }

        async function saveOscListenerReceiver(ip, port) {
            try {
                if (!ip || !port || isNaN(port)) return;
                await fetch('/api/osc_listener_receiver', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ip, port })
                });
            } catch (e) {
                log('OSC listener save failed', 'wrn');
            }
        }

        function attachOscReceiverAutosave() {
            const ipEl = document.getElementById('commOscRecvIp');
            const portEl = document.getElementById('commOscRecvPort');
            if (!ipEl || !portEl) return;
            const handler = () => {
                const ip = ipEl.value;
                const port = parseInt(portEl.value);
                saveOscListenerReceiver(ip, port);
            };
            ipEl.addEventListener('change', handler);
            portEl.addEventListener('change', handler);
        }

        function updateCommOscStatus(connected, mode) {
            const dot = document.getElementById('commOscStatusDot');
            const text = document.getElementById('commOscStatusText');
            const connectBtn = document.getElementById('commOscConnectBtn');
            const disconnectBtn = document.getElementById('commOscDisconnectBtn');
            const connectionInfo = document.getElementById('commOscConnectionInfo');
            const recvInfo = document.getElementById('commOscRecvInfo');
            const sendInfo = document.getElementById('commOscSendInfo');

            if (connected) {
                dot.className = 'status-dot connected';
                const modeNames = {1: 'Receiving', 2: 'Sending', 3: 'Both'};
                text.textContent = modeNames[mode] || 'Connected';
                connectBtn.disabled = true;
                disconnectBtn.disabled = false;
                connectionInfo.style.display = 'block';
                if (mode === 1 || mode === 3) {
                    const recvIp = document.getElementById('commOscRecvIp').value;
                    const recvPort = document.getElementById('commOscRecvPort').value;
                    recvInfo.textContent = `Listening: ${recvIp}:${recvPort}`;
                    recvInfo.style.display = 'block';
                } else {
                    recvInfo.style.display = 'none';
                }
                if (mode === 2 || mode === 3) {
                    const sendIp = document.getElementById('commOscSendIp').value;
                    const sendPort = document.getElementById('commOscSendPort').value;
                    sendInfo.textContent = `Sending to: ${sendIp}:${sendPort}`;
                    sendInfo.style.display = 'block';
                } else {
                    sendInfo.style.display = 'none';
                }
            } else {
                dot.className = 'status-dot disconnected';
                text.textContent = 'Disconnected';
                connectBtn.disabled = false;
                disconnectBtn.disabled = true;
                connectionInfo.style.display = 'none';
            }
        }

        // Update info tooltip steps based on system state
        function updateInfoTooltipSteps() {
            const tipStep1 = document.getElementById('tipStep1');
            const tipStep2 = document.getElementById('tipStep2');
            const tipStep3 = document.getElementById('tipStep3');
            const tipStep3Title = document.getElementById('tipStep3Title');
            const tipStep3List = document.getElementById('tipStep3List');

            if (hasFault) {
                tipStep1.style.display = 'block';
                tipStep2.style.display = 'none';
                tipStep3.style.display = 'none';
            } else if (!isEnabled) {
                tipStep1.style.display = 'none';
                tipStep2.style.display = 'block';
                tipStep3.style.display = 'none';
            } else {
                tipStep1.style.display = 'none';
                tipStep2.style.display = 'none';
                tipStep3.style.display = 'block';

                const modeNames = {8: 'CSP', 1: 'PP', 3: 'PV'};
                tipStep3Title.textContent = `Step 3: ${modeNames[selectedMode] || 'Mode'} Active`;

                let tips = '';
                if (selectedMode === 8) {
                    tips = '<li>Use quick buttons for preset positions</li><li>Enter custom position and click Move</li><li>Real-time interactive control</li>';
                } else if (selectedMode === 1) {
                    tips = '<li>Use quick buttons or enter position</li><li>Load config for templates</li><li>Run template sequences</li>';
                } else if (selectedMode === 3) {
                    tips = '<li>Use Forward/Backward buttons</li><li>Adjust speed with slider</li><li>Click Stop to halt motion</li>';
                }
                tipStep3List.innerHTML = tips;
            }
        }

        // Close tooltips when clicking outside
        document.addEventListener('click', function(e) {
            const infoTooltip = document.querySelector('.info-tooltip');
            const infoContent = document.getElementById('infoTooltipContent');
            if (!infoTooltip.contains(e.target) && infoContent.classList.contains('show')) {
                infoContent.classList.remove('show');
            }
            const commTooltip = document.querySelector('.comm-tooltip');
            const commContent = document.getElementById('commTooltipContent');
            if (!commTooltip.contains(e.target) && commContent.classList.contains('show')) {
                commContent.classList.remove('show');
            }
        });

        // ============================================================
        // Interface Selection Overlay
        // ============================================================

        function showInterfaceOverlay() {
            interfaceOverlayShown = true;
            document.getElementById('interfaceOverlay').classList.add('show');
            log('Interface not connected - showing interface selection', 'wrn');
            scanInterfaces();
        }

        function hideInterfaceOverlay() {
            interfaceOverlayShown = false;
            document.getElementById('interfaceOverlay').classList.remove('show');
        }

        async function scanInterfaces() {
            const scanning = document.getElementById('interfaceScanning');
            const listContainer = document.getElementById('interfaceListContainer');
            const statusMsg = document.getElementById('interfaceStatusMsg');
            const scanTime = document.getElementById('interfaceScanTime');

            scanning.style.display = 'block';
            listContainer.style.display = 'none';
            statusMsg.className = 'interface-status-msg';
            statusMsg.style.display = 'none';

            const startTime = Date.now();

            try {
                const response = await fetch('/api/scan_interfaces');
                const data = await response.json();
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                scanTime.textContent = `Scan completed in ${elapsed}s`;

                const interfaces = data.interfaces || [];

                if (interfaces.length === 0) {
                    listContainer.innerHTML = '<div style="text-align:center; color:var(--text-secondary); padding:20px;">No network adapters found.</div>';
                } else {
                    // Sort: GBL first, then by slave count descending
                    interfaces.sort((a, b) => {
                        if (a.is_gbl !== b.is_gbl) return (b.is_gbl ? 1 : 0) - (a.is_gbl ? 1 : 0);
                        return b.slave_count - a.slave_count;
                    });

                    let html = '';
                    interfaces.forEach(iface => {
                        const hasSlaves = iface.slave_count > 0;
                        const isGbl = iface.is_gbl;

                        let rowClasses = 'interface-row';
                        if (hasSlaves) rowClasses += ' has-slaves';
                        if (isGbl) rowClasses += ' is-gbl';

                        const escapedName = iface.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                        const onclick = hasSlaves ? `onclick="selectInterface('${escapedName}')"` : '';

                        html += `<div class="${rowClasses}" ${onclick}>
                            <div class="iface-info">
                                <div class="iface-desc">${iface.desc}</div>
                                <div class="iface-name">${iface.name}</div>
                            </div>
                            <div class="iface-badge">
                                ${isGbl ? '<span class="gbl-badge">GBL</span>' : ''}
                                <span class="slave-count ${hasSlaves ? 'has-slaves' : 'no-slaves'}">
                                    ${hasSlaves ? iface.slave_count + ' slave' + (iface.slave_count > 1 ? 's' : '') : 'No slaves'}
                                </span>
                            </div>
                        </div>`;
                    });
                    listContainer.innerHTML = html;
                }

                scanning.style.display = 'none';
                listContainer.style.display = 'flex';

            } catch (e) {
                scanning.style.display = 'none';
                listContainer.style.display = 'flex';
                listContainer.innerHTML = `<div style="text-align:center; color:var(--accent-red); padding:20px;">Failed to scan interfaces: ${e.message}</div>`;
            }
        }

        async function selectInterface(interfaceName) {
            const statusMsg = document.getElementById('interfaceStatusMsg');

            // Show saving state
            statusMsg.className = 'interface-status-msg saving';
            statusMsg.textContent = 'Saving interface configuration...';

            try {
                // Fetch current config
                const configResponse = await fetch('/api/config');
                const config = await configResponse.json();

                // Update network_interface
                if (!config.config) config.config = {};
                config.config.network_interface = interfaceName;

                // Save config
                await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config)
                });

                log(`Interface saved: ${interfaceName}`, 'sys');

                // Restart motor process
                statusMsg.textContent = 'Restarting motor process...';

                const restartResponse = await fetch('/api/restart_motor', { method: 'POST' });
                const restartResult = await restartResponse.json();

                if (restartResult.success) {
                    statusMsg.className = 'interface-status-msg success';
                    statusMsg.textContent = `Connected! ${restartResult.message}`;
                    log(`Motor restarted: ${restartResult.message}`, 'sys');
                    disconnectedCounter = 0;
                    setTimeout(() => hideInterfaceOverlay(), 1500);
                } else {
                    statusMsg.className = 'interface-status-msg error';
                    statusMsg.textContent = `Connection failed: ${restartResult.message}`;
                    log(`Restart failed: ${restartResult.message}`, 'err');
                }

            } catch (e) {
                statusMsg.className = 'interface-status-msg error';
                statusMsg.textContent = `Error: ${e.message}`;
                log(`Interface selection error: ${e.message}`, 'err');
            }
        }

        // Connect WebSocket
        function connectWS() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws?page=newui`;

            try {
                ws = new WebSocket(wsUrl);
            } catch (e) {
                log('WebSocket creation failed', 'err');
                return;
            }

            ws.onopen = () => {
                document.getElementById('wsDot').className = 'status-dot enabled';
                log('WebSocket connected', 'sys');
                window.wsRetryCount = 0;
                isFirstStatus = true; // Re-check state on reconnect
                if (reconnectTimer) {
                    clearInterval(reconnectTimer);
                    reconnectTimer = null;
                }
                setTimeout(() => refreshConfigList(), 500);
            };

            ws.onclose = (event) => {
                document.getElementById('wsDot').className = 'status-dot disconnected';
                if (isTerminating) {
                    log('Program terminated - connection closed', 'sys');
                    return;
                }
                log(`WebSocket disconnected (code: ${event.code})`, 'wrn');
                if (!reconnectTimer) {
                    window.wsRetryCount = (window.wsRetryCount || 0) + 1;
                    const retryDelay = Math.min(1000 * window.wsRetryCount, 5000);
                    log(`Reconnecting in ${retryDelay/1000}s...`, 'sys');
                    reconnectTimer = setTimeout(() => {
                        reconnectTimer = null;
                        connectWS();
                    }, retryDelay);
                }
            };

            ws.onerror = (e) => {
                if (isTerminating) return;
                log('WebSocket error - check server connection', 'err');
            };

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'status') {
                        updateStatus(msg.data);
                    } else if (msg.type === 'response') {
                        handleResponse(msg.data);
                    }
                } catch (e) {
                    console.error('Message parse error:', e);
                }
            };
        }

        // Update UI with status (optimized to minimize DOM updates)
        function updateStatus(status) {
            const statusWords = status.status_words || [];
            const errorCodes = status.error_codes || [];
            let faultDetected = false;
            let faultSlaves = [];

            // Use backend-computed has_fault (checks fault bit + known Leadshine error code)
            faultDetected = !!status.has_fault;
            if (faultDetected) {
                for (let i = 0; i < statusWords.length; i++) {
                    if (statusWords[i] & 0x0008) faultSlaves.push(i);
                }
            }

            hasFault = faultDetected;
            isEnabled = status.state === 2;

            // Auto-restore full state on first status after page load/reconnect
            if (isFirstStatus) {
                isFirstStatus = false;

                // Validate cached template running state against backend
                if (status.template_running && !isTemplateRunning) {
                    setTemplateRunning(true);
                } else if (!status.template_running && isTemplateRunning) {
                    // Template stopped while page was closed
                    setTemplateRunning(false);
                }

                // If cache didn't restore config, load from backend
                if (status.state === 2 && !loadedConfig) {
                    const filename = status.template_filename || '';
                    if (filename) {
                        restoreLoadedConfig(filename);
                    } else {
                        restoreLoadedConfigFromDefault();
                    }
                }

                // Sync cached mode to backend if it differs
                // (prevents backend default mode from overwriting user's last selection)
                if (selectedMode && status.mode !== undefined && status.mode !== selectedMode && status.state === 2) {
                    sendCmd('set_mode', { mode: selectedMode });
                    lastStatusMode = selectedMode;
                }

                // Ensure correct action panels show for cached mode
                showCorrectModeActions();
            }

            // Store global state for position table indicator updates
            window.lastStatusState = status.state;

            // Only update status display if state changed
            const stateKey = `${status.state}-${faultDetected}-${status.moving}-${faultSlaves.join(',')}`;
            if (stateKey !== lastStatusStateKey) {
                lastStatusStateKey = stateKey;

                const dot = document.getElementById('statusDot');
                const text = document.getElementById('statusText');
                const ethercatStatus = document.getElementById('ethercatStatus');

                dot.className = 'status-dot';
                if (faultDetected) {
                    dot.classList.add('fault');
                    text.textContent = `FAULT (Slave ${faultSlaves.map(s => `#${s+1}`).join(', ')})`;
                    text.style.color = 'var(--accent-red)';
                    ethercatStatus.textContent = 'FAULT';
                    ethercatStatus.style.color = 'var(--accent-red)';
                } else {
                    text.style.color = '';
                    if (status.state === 0) {
                        dot.classList.add('disconnected');
                        text.textContent = 'Disconnected';
                        ethercatStatus.textContent = 'Disconnected';
                        ethercatStatus.style.color = 'var(--accent-red)';
                    } else if (status.state === 1) {
                        dot.classList.add('connected');
                        text.textContent = 'Connected';
                        ethercatStatus.textContent = 'Connected';
                        ethercatStatus.style.color = 'var(--text-gold)';
                    } else if (status.state === 2) {
                        dot.classList.add('enabled');
                        text.textContent = 'Enabled';
                        ethercatStatus.textContent = 'Enabled';
                        ethercatStatus.style.color = 'var(--accent-green)';
                    }
                    if (status.moving) {
                        dot.classList.remove('enabled', 'connected');
                        dot.classList.add('moving');
                        text.textContent += ' (Moving...)';
                    }
                }

                // Update UI state only when state changes
                updateInterfaceState();
                updateAllButtonStates();
            }

            // Interface selection: detect persistent disconnection
            if (status.state === 0 && (status.num_slaves || 0) === 0) {
                disconnectedCounter++;
                if (disconnectedCounter >= 10 && !interfaceOverlayShown) {
                    showInterfaceOverlay();
                }
            } else {
                disconnectedCounter = 0;
                if (interfaceOverlayShown) {
                    hideInterfaceOverlay();
                }
            }

            // Only update mode if changed
            if (status.mode !== undefined && status.mode !== lastStatusMode) {
                lastStatusMode = status.mode;
                selectedMode = status.mode;
                const modeNames = {1: 'PP', 3: 'PV', 8: 'CSP'};
                const modeName = modeNames[status.mode] || status.mode;
                document.getElementById('modeLabel').textContent = modeName;
                document.querySelectorAll('.mode-item').forEach(el => {
                    el.classList.toggle('active', parseInt(el.dataset.mode) === status.mode);
                });
                // Update mode label next to Operation title
                const opModeLabel = document.getElementById('operationModeLabel');
                if (opModeLabel) {
                    opModeLabel.textContent = `(${modeName} Mode)`;
                }
                updateModeDisplay(status.mode);
                saveStateCache();
            }

            // Only update slave count if changed
            const numSlaves = status.num_slaves || status.positions?.length || 0;
            if (numSlaves !== lastNumSlaves) {
                lastNumSlaves = numSlaves;
                document.getElementById('slaveCount').textContent = numSlaves;
                updateSlaveSelector(numSlaves);
                // Re-filter config list when slave count changes
                refreshConfigList();
            }

            // Only update interface if changed
            if (status.interface && status.interface !== lastInterface) {
                lastInterface = status.interface;
                document.getElementById('interfaceDisplay').textContent = status.interface;
            }

            // Always update position table (positions change frequently)
            updatePositionTable(status);

            // Update operation status
            updateOperationStatus(status);

            // Update UDP/OSC/Hexora status (global comm panel)
            if (status.udp_connected !== undefined) {
                updateCommUdpStatus(status.udp_connected);
                // Sync UDP mode radio
                if (status.udp_mode !== undefined) {
                    const radio = document.querySelector(`input[name="udpMode"][value="${status.udp_mode}"]`);
                    if (radio) radio.checked = true;
                }
            }
            if (status.osc_connected !== undefined) {
                const oscMode = status.osc_mode || 3;
                updateCommOscStatus(status.osc_connected, oscMode);
            }
        }

        // Update interface state (controls visibility)
        function updateInterfaceState() {
            // Error controls: Show when there's a fault
            document.getElementById('errorControls').classList.toggle('hidden', !hasFault);

            // Startup controls: Show when no fault and not enabled
            const showStartup = !hasFault && !isEnabled;
            document.getElementById('startupControls').classList.toggle('hidden', !showStartup);

            // Mode actions: Show when enabled AND no fault
            // When fault occurs, hide mode actions even if enabled
            const showModeActions = isEnabled && !hasFault;
            document.getElementById('modeActions').classList.toggle('hidden', !showModeActions);

            if (showModeActions) {
                showCorrectModeActions();
            }

            // Update info tooltip steps
            updateInfoTooltipSteps();
        }

        // Update all button states based on fault/enabled state
        function updateAllButtonStates() {
            const enableBtn = document.getElementById('enableBtn');
            const resetBtn = document.getElementById('resetBtn');
            const modeItems = document.querySelectorAll('.mode-item');
            const setHomeBtn = document.getElementById('setHomeBtn');
            const setHomeAllBtn = document.getElementById('setHomeAllBtn');

            // Enable/Reset buttons
            if (hasFault) {
                enableBtn.disabled = true;
                enableBtn.title = 'Clear faults first';
                modeItems.forEach(el => el.classList.add('disabled'));
                resetBtn.disabled = false;
            } else if (isEnabled) {
                enableBtn.disabled = true;
                enableBtn.textContent = 'Enabled';
                modeItems.forEach(el => el.classList.add('disabled'));
                resetBtn.disabled = true;
            } else {
                enableBtn.disabled = false;
                enableBtn.textContent = 'Enable';
                enableBtn.title = '';
                modeItems.forEach(el => el.classList.remove('disabled'));
                resetBtn.disabled = false;
            }

            // Set Home buttons - disabled when enabled or has fault
            if (setHomeBtn) {
                const homeSlaveSelected = document.getElementById('homeSlaveSelect').value !== '';
                if (isEnabled || hasFault) {
                    setHomeBtn.disabled = true;
                    setHomeBtn.title = isEnabled ? 'Disable drives first' : 'Clear faults first';
                } else {
                    setHomeBtn.disabled = !homeSlaveSelected;
                    setHomeBtn.title = homeSlaveSelected ? '' : 'Select a slave first';
                }
            }

            if (setHomeAllBtn) {
                if (isEnabled || hasFault) {
                    setHomeAllBtn.disabled = true;
                    setHomeAllBtn.title = isEnabled ? 'Disable drives first' : 'Clear faults first';
                } else {
                    setHomeAllBtn.disabled = false;
                    setHomeAllBtn.title = '';
                }
            }

            // All to Home buttons - enabled only when drives are enabled and no fault
            const allToHomeBtn = document.getElementById('allToHomeBtn');
            const allToHomePPBtn = document.getElementById('allToHomePPBtn');
            const canMoveAllHome = isEnabled && !hasFault;

            if (allToHomeBtn) {
                allToHomeBtn.disabled = !canMoveAllHome;
                allToHomeBtn.title = hasFault ? 'Clear faults first' : (!isEnabled ? 'Enable drives first' : '');
            }
            if (allToHomePPBtn) {
                allToHomePPBtn.disabled = !canMoveAllHome;
                allToHomePPBtn.title = hasFault ? 'Clear faults first' : (!isEnabled ? 'Enable drives first' : '');
            }

            // Update mode-specific button states
            updateButtonStates();
        }

        // Update button states based on slave selection
        function updateButtonStates() {
            // CSP mode buttons
            const cspSlaveSelected = document.getElementById('slaveSelect').value !== '';
            const cspQuickBtns = document.querySelectorAll('#cspQuickBtns button');
            cspQuickBtns.forEach(btn => {
                btn.disabled = !cspSlaveSelected;
            });
            const executeMoveBtn = document.getElementById('executeMoveBtn');
            if (executeMoveBtn) {
                executeMoveBtn.disabled = !cspSlaveSelected;
            }

            // PP mode buttons
            const ppSlaveSelected = document.getElementById('slaveSelectPP').value !== '';
            const ppQuickBtns = document.querySelectorAll('#ppQuickBtns button');
            ppQuickBtns.forEach(btn => {
                btn.disabled = !ppSlaveSelected;
            });
            const executeMovePPBtn = document.getElementById('executeMovePPBtn');
            if (executeMovePPBtn) {
                executeMovePPBtn.disabled = !ppSlaveSelected;
            }

            // PV mode buttons
            const pvSlaveSelected = document.getElementById('slaveSelectVel').value !== '';
            const velForwardBtn = document.getElementById('velForwardBtn');
            const velBackwardBtn = document.getElementById('velBackwardBtn');
            if (velForwardBtn) velForwardBtn.disabled = !pvSlaveSelected;
            if (velBackwardBtn) velBackwardBtn.disabled = !pvSlaveSelected;

            // Home slave select button
            const homeSlaveSelected = document.getElementById('homeSlaveSelect').value !== '';
            const setHomeBtn = document.getElementById('setHomeBtn');
            if (setHomeBtn && !isEnabled && !hasFault) {
                setHomeBtn.disabled = !homeSlaveSelected;
            }

            // Clear error button
            const clearErrorSlaveSelected = document.getElementById('clearErrorSlaveSelect').value !== '';
            const clearErrorBtn = document.getElementById('clearErrorBtn');
            if (clearErrorBtn) {
                clearErrorBtn.disabled = !clearErrorSlaveSelected;
            }
        }

        // Update mode display
        function updateModeDisplay(mode) {
            const modeNames = {8: 'CSP (Cyclic Sync Position)', 1: 'PP (Profile Position)', 3: 'PV (Profile Velocity)'};
            document.getElementById('currentModeDisplay').textContent = `Selected Mode: ${modeNames[mode] || mode}`;
        }

        function showCorrectModeActions() {
            document.getElementById('cspActions').classList.add('hidden');
            document.getElementById('ppActions').classList.add('hidden');
            document.getElementById('pvActions').classList.add('hidden');

            if (selectedMode === 8) {
                document.getElementById('cspActions').classList.remove('hidden');
            } else if (selectedMode === 1) {
                document.getElementById('ppActions').classList.remove('hidden');
            } else if (selectedMode === 3) {
                document.getElementById('pvActions').classList.remove('hidden');
            }
        }

        // Cache for position table to avoid unnecessary DOM updates
        let lastPositionTableData = null;

        // Leadshine Drive Error Code Lookup Table (from drive-error-list-leadshine.pdf)
        const ERROR_CODE_MAP = {
            // Display codes (0x3FFE format) - these match what we typically see
            0x0e0: 'Over Current',
            0x0c0: 'Over Voltage',
            0x100: 'Overload',
            0x120: 'Regenerative Discharge Circuit Overload',
            0x121: 'Regenerative Resistance Error',
            0x150: 'Encoder Connection Error',
            0x151: 'Encoder Communication Error',
            0x152: 'Initialize Encoder Position Error',
            0x170: 'Encoder Data Error',
            0x180: 'Position Following Error',
            0x190: 'Excessive Vibration Error',
            0x1a0: 'Over Speed',
            0x1a1: 'Speed Out of Control',
            0x1b0: 'Position Instruction Frequency Too Large',
            0x1b1: 'Electronic Gear Setup Error',
            0x240: 'EEPROM Parameters Saving Error',
            0x241: 'Saving Module Hardware Error',
            0x242: 'Error/Diagnosis Record Keeping Error',
            0x243: 'Saving Signals Error',
            0x244: 'Communication Parameters Saving Error',
            0x245: 'Motion Parameters Saving Error',
            0x260: 'Overtravel Positive/Negative Input Valid',
            0x570: 'Quick Stop Alarm',
            0x5f0: 'Auto-tuning Error',
            0x801: 'ESM State Machine Conversion Failed',
            0x802: 'Out of Memory',
            0x807: 'Mapping Object Does Not Exist',
            0x808: 'PDO Mapping Object Length Error',
            0x809: 'PDO Mapping Object Has No Mapping Attribute',
            0x811: 'Invalid ESM Conversion Request',
            0x812: 'Unknown ESM Conversion Request',
            0x813: 'Boot State Request Protection',
            0x815: 'Invalid Boot Status Mailbox Configuration',
            0x816: 'Invalid Pre-Operation Mailbox Configuration',
            0x818: 'Invalid Input Data',
            0x819: 'Invalid Output Data',
            0x81a: 'Synchronizing Error',
            0x81b: 'Watchdog Timeout',
            0x81c: 'Invalid Type of Synchronization Manager',
            0x81d: 'Invalid Output Configuration',
            0x81e: 'Invalid Input Configuration',
            0x821: 'Waiting for ESM Initialization',
            0x822: 'Waiting for ESM Pre-Operation',
            0x823: 'Waiting for ESM Safe Operation',
            0x824: 'Invalid Input Data Mapping',
            0x825: 'Invalid Output Data Mapping',
            0x827: 'Free Running Mode Not Supported',
            0x828: 'Synchronizing Mode Not Supported',
            0x82b: 'Input and Output Invalid',
            0x82c: 'Fatal Synchronization Error',
            0x82d: 'Asynchronous Error',
            0x82e: 'Synchronizing Cycle Too Short',
            0x830: 'DC Synchronization Configuration Invalid',
            0x832: 'DC Phase-Locked Loop Failure',
            0x833: 'DC Sync IO Error',
            0x834: 'DC Synchronization Timeout',
            0x835: 'Invalid DC Cycle',
            0x836: 'Invalid DC Synchronizing Cycle',
            0x850: 'EEPROM Reading Error',
            0x851: 'EEPROM Error',
            0x852: 'Hardware Not Ready',
            0x870: 'Mode Not Supported',
            0x871: 'Operation Condition Not Satisfied',
            // Object 0x603F codes (IEC 61800 format)
            0x2211: 'Over Current',
            0x3211: 'Over Voltage',
            0x3150: 'EEPROM Error Phase A',
            0x3151: 'EEPROM Error Phase B',
            0x5201: 'Unsupported Operation Mode',
            0x5202: 'Operation Condition Not Satisfied',
            0x5441: 'Quick Stop Alarm',
            0x5510: 'Memory Overflow',
            0x5530: 'Save Error',
            0x5531: 'Saving Module Hardware Error',
            0x5532: 'Error/Diagnosis Record Keeping Error',
            0x5533: 'Saving Signals Error',
            0x5534: 'Communication Parameters Saving Error',
            0x5535: 'Motion Parameters Saving Error',
            0x5550: 'EEPROM Inaccessible',
            0x5551: 'EEPROM Error',
            0x5552: 'Hardware Not Ready',
            0x7122: 'Auto-tuning Error',
            0x7321: 'Encoder Wiring Error',
            0x7329: 'Limit Switch Alarm',
            0x8201: 'ESM State Machine Transition Failed',
            0x8207: 'Mapping Object Does Not Exist',
            0x8208: 'PDO Mapping Object Length Error',
            0x8209: 'PDO Mapping Object Has No Mapping Attribute',
            0x8210: 'Invalid Input and Output',
            0x8211: 'No Valid Input Data',
            0x8212: 'No Valid Output Data',
            0x8213: 'Boot State Request Protection',
            0x8215: 'Invalid Boot Status Mailbox Configuration',
            0x8216: 'PreOp Mailbox Error',
            0x821B: 'Watchdog Timeout',
            0x821C: 'Invalid Sync Manager Type',
            0x821D: 'Invalid Output Configuration',
            0x821E: 'Invalid Input Configuration',
            0x8224: 'Invalid Process Data Input Mapping',
            0x8225: 'Invalid Process Data Output Mapping',
            0x8402: 'Over Speed',
            0x8611: 'Position Following Error',
            0x8727: 'Free Running Mode Not Supported',
            0x8728: 'Synchronous Mode Not Supported',
            0x872C: 'Fatal Sync Error',
            0x872D: 'No Synchronization Errors',
            0x872E: 'Synchronization Period Too Small',
            0x8730: 'Invalid DC Synchronization Configuration',
            0x8732: 'DC Phase Locked Loop Failure',
            0x8733: 'DC Sync IO Error',
            0x8734: 'DC Synchronization Timeout',
            0x8735: 'Invalid DC Cycle',
            0x8736: 'Invalid DC Synchronization Period',
            0xA001: 'Invalid ESM Conversion Request',
            0xA002: 'Unknown ESM Conversion Request',
            0xA003: 'Waiting for ESM Initialization',
            0xA004: 'Waiting for ESM Pre-Operation',
            0xA005: 'Waiting for ESM Safe Operation',
            0xFF02: 'Synchronizing Error'
        };

        // Get error name from error code
        function getErrorName(errorCode) {
            if (errorCode === 0) return null;
            // Try direct lookup
            if (ERROR_CODE_MAP[errorCode]) {
                return ERROR_CODE_MAP[errorCode];
            }
            // Try lowercase version for display codes (e.g., 0x81b -> 0x81B)
            const upperCode = errorCode & 0xFFFF;
            if (ERROR_CODE_MAP[upperCode]) {
                return ERROR_CODE_MAP[upperCode];
            }
            return null;
        }

        // Drive display error codes (matches actual servo drive Er codes)
        const ERROR_DISPLAY_MAP = {
            0x3150:'Overcurrent A (Er0A0)', 0x3151:'Overcurrent B (Er0A1)', 0x3153:'Motor cable (Er0A3)',
            0x3206:'Power high (Er0b1)', 0x3211:'Bus overvolt (Er0C0)', 0x3221:'Bus undervolt (Er0d0)',
            0x3130:'Single phase (Er0d1)', 0x3222:'No main power (Er0d2)',
            0x2211:'Overcurrent (Er0E0)', 0x2212:'IPM overcurrent (Er0E1)',
            0x2218:'Ground short (Er0E2)', 0x2230:'Phase overcurrent (Er0E4)',
            0x4210:'Overheat (Er0f0)', 0x8311:'Motor overload (Er100)', 0x8310:'Driver overload (Er101)',
            0x8301:'Rotor blocked (Er102)',
            0x7701:'Regen overvolt (Er120)', 0x7702:'Brake error (Er121)',
            0x7321:'Encoder disconnected (Er150)', 0x7322:'Encoder comm (Er151)',
            0x7323:'Encoder init (Er152)', 0x7325:'Multiturn (Er153)',
            0x7326:'Encoder overflow (Er155)', 0x7327:'Encoder overheat (Er156)',
            0x7328:'Encoder count (Er157)', 0x7324:'Encoder data (Er170)',
            0x8611:'Position deviation (Er180)', 0x8401:'Vibration (Er190)',
            0x8402:'Overspeed (Er1A0)', 0x8403:'Velocity (Er1A1)',
            0x8313:'STO failed (Er1c0)',
            0x5530:'EEPROM init (Er240)', 0x5531:'EEPROM hw (Er241)',
            0x7329:'Limit triggered (Er260)',
            0x5441:'Quick stop (Er570)', 0x7122:'Motor detect (Er5f0)',
            0x6204:'Loop timeout (Er600)',
            0x873A:'SM2 lost (Er73A)', 0x873B:'SYNC0 lost (Er73b)', 0x873C:'DC error (Er73c)',
            0x8201:'Comm error (Er801)',
            0x821B:'Timeout (Er81b)', 0x821C:'Invalid SM (Er81C)',
            0x821D:'Invalid output (Er81d)', 0x821E:'Invalid input (Er81E)',
            0x872C:'DC watchdog (Er82c)', 0x872D:'No sync (Er82d)',
            0x5550:'EEPROM access (Er850)', 0x5551:'EEPROM error (Er851)'
        };

        // Format error display using drive Er codes (same as simpleui)
        function formatErrorStatus(errorCode) {
            if (errorCode === 0) return 'Fault';
            if (ERROR_DISPLAY_MAP[errorCode]) {
                return ERROR_DISPLAY_MAP[errorCode];
            }
            // Fallback: use ERROR_CODE_MAP name or raw hex
            const hexCode = errorCode.toString(16).toUpperCase();
            const errorName = getErrorName(errorCode);
            if (errorName) {
                return `${errorName} (0x${hexCode})`;
            }
            return `Error (0x${hexCode})`;
        }

        // Update position table (optimized to only update changed values)
        function updatePositionTable(status) {
            const tbody = document.getElementById('positionTable');
            const positions = status.positions || [];
            const statusWords = status.status_words || [];
            const errorCodes = status.error_codes || [];

            // Check if we need to rebuild the table structure
            const rows = tbody.querySelectorAll('tr');
            // Rebuild if row count differs OR if IDs don't exist (first run with initial HTML)
            const needsRebuild = rows.length !== positions.length || !document.getElementById('status-0');

            if (needsRebuild && positions.length > 0) {
                // Build table structure once
                let html = '';
                for (let i = 0; i < positions.length; i++) {
                    html += `
                        <tr data-slave="${i}">
                            <td><span class="indicator" id="indicator-${i}"></span></td>
                            <td>#${String(i + 1).padStart(2, '0')}</td>
                            <td id="pos-${i}"></td>
                            <td id="status-${i}"></td>
                        </tr>
                    `;
                }
                tbody.innerHTML = html;
            }

            // Update only changed values
            // Get global state to determine connected/disconnected
            const globalState = window.lastStatusState || 0;

            for (let i = 0; i < positions.length; i++) {
                const pos = positions[i].toFixed(4);
                const sw = statusWords[i] || 0;
                const enabled = (sw & 0x006F) === 0x0027;
                const fault = (sw & 0x0008) !== 0;

                // Update position cell
                const posEl = document.getElementById(`pos-${i}`);
                if (posEl && posEl.textContent !== pos) {
                    posEl.textContent = pos;
                }

                // Update indicator and status
                const indicator = document.getElementById(`indicator-${i}`);
                const statusEl = document.getElementById(`status-${i}`);

                let indicatorClass = 'indicator-disabled';
                let statusText = 'Disabled';
                let statusColor = 'inherit';

                if (fault) {
                    indicatorClass = 'indicator-error';
                    const errorCode = errorCodes[i] || 0;
                    statusText = formatErrorStatus(errorCode);
                    statusColor = 'var(--accent-red)';
                } else if (enabled) {
                    indicatorClass = 'indicator-ok';
                    statusText = 'Enabled';
                    statusColor = 'var(--accent-green)';
                } else if (globalState >= 1) {
                    // Connected but disabled - show yellow
                    indicatorClass = 'indicator-connected';
                    statusText = 'Disabled';
                    statusColor = 'var(--text-gold)';
                }

                if (indicator) {
                    indicator.className = `indicator ${indicatorClass}`;
                }
                if (statusEl) {
                    if (statusEl.textContent !== statusText) {
                        statusEl.textContent = statusText;
                    }
                    statusEl.style.color = statusColor;
                }
            }

            // Update loop test live position if running and moving
            if (loopTestRunning && loopTestSelectedSlave !== null && !loopTestDelayTimer) {
                const slavePos = positions[loopTestSelectedSlave];
                if (slavePos !== undefined) {
                    const valueEl = document.getElementById('loopTestLiveValue');
                    if (valueEl) {
                        valueEl.textContent = slavePos.toFixed(4) + ' m';
                    }
                }
            }

            // Update multi-loop test live positions if running
            if (multiLoopRunning && multiLoopSelectedSlaves.size > 0) {
                updateMultiLoopMonitor(positions);
            }
        }

        // Update operation status display
        function updateOperationStatus(status) {
            const opStatus = document.getElementById('operationStatus');
            if (!opStatus) return;

            let statusText = 'Idle';
            let statusColor = 'var(--text-secondary)';

            if (status.has_fault || hasFault) {
                statusText = 'Fault';
                statusColor = 'var(--accent-red)';
            } else if (status.moving) {
                statusText = 'Moving';
                statusColor = 'var(--accent-blue)';
            } else if (loopTestRunning) {
                statusText = 'Loop Test Running';
                statusColor = 'var(--text-gold)';
            } else if (multiLoopRunning) {
                statusText = 'Multi-Loop Test Running';
                statusColor = 'var(--accent-purple)';
            } else if (isTemplateRunning) {
                statusText = 'Template Running';
                statusColor = 'var(--accent-green)';
            } else if (status.state === 2) {
                statusText = 'Ready';
                statusColor = 'var(--accent-green)';
            } else if (status.state === 1) {
                statusText = 'Connected';
                statusColor = 'var(--text-gold)';
            } else if (status.state === 0) {
                statusText = 'Disconnected';
                statusColor = 'var(--accent-red)';
            }

            if (opStatus.textContent !== statusText) {
                opStatus.textContent = statusText;
                opStatus.style.color = statusColor;
            }
        }

        // Update slave selector
        function updateSlaveSelector(count) {
            const selectors = ['slaveSelect', 'slaveSelectPP', 'slaveSelectVel', 'homeSlaveSelect', 'clearErrorSlaveSelect', 'loopTestSlaveSelect'];

            selectors.forEach(id => {
                const select = document.getElementById(id);
                if (!select) return;

                const currentVal = select.value;
                const currentCount = select.options.length - 1;
                if (currentCount === count && count > 0) return;

                let html = '<option value="">-- Select Slave --</option>';
                for (let i = 0; i < count; i++) {
                    html += `<option value="${i}">Slave #${i + 1}</option>`;
                }
                select.innerHTML = html;

                if (currentVal !== '' && parseInt(currentVal) < count) {
                    select.value = currentVal;
                }
            });

            // Update multi-loop slave grid
            updateMultiLoopSlaveGrid(count);

            updateButtonStates();
        }

        // Handle response
        function handleResponse(resp) {
            if (resp.success) {
                log(resp.message, 'sys');
            } else {
                log(resp.message, 'err');
            }

            // Handle observe_speed result
            if (resp.data && resp.data.observe_speed) {
                handleObserveSpeedResult(resp.data.observe_speed);
            }

            // Handle config files list
            if (resp.data && resp.data.config_files) {
                console.log('Config files received:', resp.data.config_files);
                updateConfigList(resp.data.config_files);
            }

            // Handle loaded config
            if (resp.data && resp.data.config) {
                updateConfigInfo(resp.data.config);
            }

            // Handle OSC log entries
            if (resp.data && resp.data.osc_log) {
                addOscLogEntry(resp.data.osc_log);
            }

            // Handle template step updates
            if (resp.data && resp.data.template_step) {
                const step = resp.data.template_step;

                // Handle step timing events
                if (step.event === 'start') {
                    log(`[Step ${step.index}/${step.total}] ${step.name} (${step.type})`, 'sys');
                    startStepTimer(step.index);

                    // Update move order display for this step
                    if (step.move_order && step.move_order.length > 0) {
                        updateStepMoveOrder(step.index, step.move_order, step.is_spreading);
                    }
                } else if (step.event === 'complete') {
                    completeStepTimer(step.index, step.time_taken || 0, step.movement_time, step.delay);
                } else {
                    // Legacy: simple step notification without event
                    log(`[Step ${step.index}/${step.total}] ${step.name}`, 'sys');
                    highlightTemplateStep(step.index);
                }
            }

            // Handle template start event (reset timings)
            if (resp.data && resp.data.template_start) {
                resetStepTimings();
                log('Template started', 'sys');
            }

            // Handle template complete event
            if (resp.data && resp.data.template_complete) {
                stopStepTimer();
                const total = resp.data.template_complete.total_time;
                if (total) {
                    log(`Template complete - Total time: ${total.toFixed(1)}s`, 'sys');
                } else {
                    log('Template complete', 'sys');
                }
                clearTemplateHighlight();
                setTemplateRunning(false);
            }

            // Handle template stopped (by stop command)
            if (resp.message && (resp.message.includes('STOP') || resp.message.includes('stopped'))) {
                stopStepTimer();
                setTemplateRunning(false);
                clearTemplateHighlight();
            }

            // Handle loop test updates
            if (resp.data && resp.data.loop_test) {
                handleLoopTestUpdate(resp.data.loop_test);
            }

            // Handle multi-slave loop test updates
            if (resp.data && resp.data.multi_loop_test) {
                handleMultiLoopTestUpdate(resp.data.multi_loop_test);
            }

            // Handle communication error
            if (resp.data && resp.data.communication_error) {
                handleCommunicationError(resp.data.error_msg, resp.data.auto_recovery);
            }

            // Handle recovery success/failure
            if (resp.data && resp.data.recovery_success !== undefined) {
                handleRecoveryResult(resp.data.recovery_success, resp.data.slaves_found, resp.data.error_msg);
            }
        }

        // Add OSC log entry to the log window
        function addOscLogEntry(entry) {
            const time = new Date().toLocaleTimeString();
            if (entry.type === 'recv') {
                log(`[OSC RECV] ${entry.message}`, 'com');
            } else if (entry.type === 'send') {
                log(`[OSC SEND] ${entry.message}`, 'sys');
            } else {
                log(`[OSC] ${entry.message}`, 'sys');
            }
        }

        // Highlight current template step
        function highlightTemplateStep(stepIndex) {
            // Clear previous highlights
            clearTemplateHighlight();

            // Highlight current step
            const row = document.getElementById(`step-row-${stepIndex}`);
            if (row) {
                row.style.background = 'rgba(88, 166, 255, 0.15)';
                row.style.borderLeft = '3px solid var(--accent-blue)';
            }
        }

        // Clear template step highlights
        function clearTemplateHighlight() {
            const rows = document.querySelectorAll('[id^="step-row-"]');
            rows.forEach(row => {
                row.style.background = '';
                row.style.borderLeft = '';
            });
        }

        // Send command
        function sendCmd(cmd, data = null) {
            if (cmd === 'stop' || cmd === 'disable') {
                console.warn(`[newui sendCmd] ${cmd} called from:`, new Error().stack);
            }
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ cmd, data }));
                if (cmd !== 'load_config') {
                    log(`Command: ${cmd}`, 'com');
                }
            } else {
                log('WebSocket not connected', 'err');
            }
        }

        // Change mode (called from mode list items)
        function selectMode(mode) {
            if (isTemplateRunning) return; // Block mode change during template
            // Bundle speed data with mode change for atomic processing
            let speedData = {};
            if (mode === 1) { // PP
                const speedUnit = parseFloat(document.getElementById('ppSpeed').value) || 80;
                const velocity = Math.round(speedUnit * 1000);
                const acceleration = Math.round(velocity / 2);
                speedData = { velocity: velocity, acceleration: acceleration, deceleration: acceleration, mode_type: 'PP' };
            } else if (mode === 3) { // PV
                const limitChecked = document.getElementById('pvSpeedLimit') ? document.getElementById('pvSpeedLimit').checked : false;
                let speedUnit = parseFloat(document.getElementById('pvSpeed').value) || 1;
                if (limitChecked && speedUnit < 0) speedUnit = 0;
                if (limitChecked && speedUnit > 5) speedUnit = 5;
                const velocity = Math.round(speedUnit * 1000);
                const acceleration = Math.round(velocity / 2);
                speedData = { velocity: velocity, acceleration: acceleration, deceleration: acceleration, mode_type: 'PV' };
            } else if (mode === 8) { // CSP
                const maxStep = parseInt(document.getElementById('cspMaxStep').value) || 800;
                speedData = { csp_velocity: maxStep, mode_type: 'CSP' };
            }
            sendCmd('set_mode', { mode: mode, speed: speedData });
            selectedMode = mode;
            // Update active state in mode list
            document.querySelectorAll('.mode-item').forEach(el => {
                el.classList.toggle('active', parseInt(el.dataset.mode) === mode);
            });
            updateModeDisplay(mode);
            log(`Changing mode to ${mode === 8 ? 'CSP' : mode === 1 ? 'PP' : 'PV'}`, 'com');
            saveStateCache();
        }

        // CSP Movement functions
        function moveTo(position) {
            const slave = document.getElementById('slaveSelect').value;
            if (slave === '') {
                log('Please select a slave first', 'err');
                return;
            }
            sendCmd('move', { positions: [position], slave: parseInt(slave) });
            log(`Moving Slave #${parseInt(slave) + 1} to ${position}m`, 'com');
        }

        function executeMove() {
            const slave = document.getElementById('slaveSelect').value;
            const position = parseFloat(document.getElementById('targetPosition').value);
            if (slave === '') {
                log('Please select a slave first', 'err');
                return;
            }
            if (isNaN(position)) {
                log('Please enter a valid position', 'err');
                return;
            }
            sendCmd('move', { positions: [position], slave: parseInt(slave) });
            log(`Moving Slave #${parseInt(slave) + 1} to ${position}m`, 'com');
        }

        // PP Movement functions
        function moveToPP(position) {
            const slave = document.getElementById('slaveSelectPP').value;
            if (slave === '') {
                log('Please select a slave first', 'err');
                return;
            }
            sendCmd('move', { positions: [position], slave: parseInt(slave) });
            log(`Moving Slave #${parseInt(slave) + 1} to ${position}m`, 'com');
        }

        function executeMovePP() {
            const slave = document.getElementById('slaveSelectPP').value;
            const position = parseFloat(document.getElementById('targetPositionPP').value);
            if (slave === '') {
                log('Please select a slave first', 'err');
                return;
            }
            if (isNaN(position)) {
                log('Please enter a valid position', 'err');
                return;
            }
            sendCmd('move', { positions: [position], slave: parseInt(slave) });
            log(`Moving Slave #${parseInt(slave) + 1} to ${position}m`, 'com');
        }

        function moveAllToHome() {
            sendCmd('move_all_home');
            log('Moving all slaves to home position', 'com');
        }

        // Communication error state
        let communicationErrorActive = false;
        let recoveryInProgress = false;

        function handleCommunicationError(errorMsg, autoRecovery) {
            communicationErrorActive = true;
            recoveryInProgress = autoRecovery;

            // Show error banner
            showErrorBanner(`COMMUNICATION ERROR: ${errorMsg}`, autoRecovery ? 'Auto-recovery in progress...' : 'Manual recovery required');

            // Log the error
            log(`[COMM ERROR] ${errorMsg}`, 'err');
            if (autoRecovery) {
                log('[RECOVERY] Auto-recovery initiated...', 'wrn');
            }

            // Stop any running operations
            if (isTemplateRunning) {
                setTemplateRunning(false);
                clearTemplateHighlight();
                stopStepTimer();
            }
            if (loopTestRunning) {
                loopTestRunning = false;
                if (loopTestDelayTimer) {
                    clearInterval(loopTestDelayTimer);
                    loopTestDelayTimer = null;
                }
            }
        }

        function handleRecoveryResult(success, slavesFound, errorMsg) {
            recoveryInProgress = false;

            if (success) {
                communicationErrorActive = false;
                hideErrorBanner();
                log(`[RECOVERY] Success! Found ${slavesFound} slaves`, 'sys');
                // UI will update automatically from status updates
            } else {
                log(`[RECOVERY] FAILED: ${errorMsg || 'Unknown error'}`, 'err');
                showErrorBanner('RECOVERY FAILED', 'Please restart the program or try manual recovery');
            }
        }

        function showErrorBanner(title, subtitle) {
            let banner = document.getElementById('errorBanner');
            if (!banner) {
                banner = document.createElement('div');
                banner.id = 'errorBanner';
                banner.style.cssText = `
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    background: linear-gradient(135deg, #dc3545 0%, #c82333 100%);
                    color: white;
                    padding: 15px 20px;
                    z-index: 10000;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    box-shadow: 0 4px 15px rgba(220, 53, 69, 0.4);
                    animation: slideDown 0.3s ease-out;
                `;
                document.body.prepend(banner);

                // Add slide animation
                const style = document.createElement('style');
                style.textContent = `
                    @keyframes slideDown {
                        from { transform: translateY(-100%); }
                        to { transform: translateY(0); }
                    }
                    @keyframes pulse {
                        0%, 100% { opacity: 1; }
                        50% { opacity: 0.7; }
                    }
                `;
                document.head.appendChild(style);
            }

            banner.innerHTML = `
                <div>
                    <div style="font-weight: bold; font-size: 1.1rem;">${title}</div>
                    <div style="font-size: 0.85rem; opacity: 0.9; animation: ${subtitle.includes('progress') ? 'pulse 1.5s infinite' : 'none'};">${subtitle}</div>
                </div>
                <div style="display: flex; gap: 10px;">
                    <button onclick="attemptManualRecovery()" style="background: white; color: #dc3545; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: bold;">
                        Retry Recovery
                    </button>
                    <button onclick="hideErrorBanner()" style="background: transparent; color: white; border: 1px solid white; padding: 8px 16px; border-radius: 4px; cursor: pointer;">
                        Dismiss
                    </button>
                </div>
            `;
            banner.style.display = 'flex';
        }

        function hideErrorBanner() {
            const banner = document.getElementById('errorBanner');
            if (banner) {
                banner.style.display = 'none';
            }
        }

        function attemptManualRecovery() {
            if (recoveryInProgress) {
                log('Recovery already in progress...', 'wrn');
                return;
            }
            recoveryInProgress = true;
            log('[RECOVERY] Attempting manual recovery...', 'wrn');
            sendCmd('recover');

            // Update banner
            const banner = document.getElementById('errorBanner');
            if (banner) {
                const subtitle = banner.querySelector('div > div:last-child');
                if (subtitle) {
                    subtitle.textContent = 'Manual recovery in progress...';
                    subtitle.style.animation = 'pulse 1.5s infinite';
                }
            }
        }

        function emergencyStop() {
            sendCmd('stop');
            log('EMERGENCY STOP - All motion stopped!', 'err');
            // Stop template if running
            if (isTemplateRunning) {
                setTemplateRunning(false);
                clearTemplateHighlight();
            }
        }

        // Velocity functions
        function velocityForward() {
            const slave = document.getElementById('slaveSelectVel').value;
            if (slave === '') {
                log('Please select a slave first', 'err');
                return;
            }
            const speed = Math.round(parseFloat(document.getElementById('pvSpeed').value) * 1000);
            sendCmd('velocity_forward', { slave: parseInt(slave), speed: speed });
            log(`Slave #${parseInt(slave) + 1} Forward: ${speed} units/s`, 'com');
        }

        function velocityBackward() {
            const slave = document.getElementById('slaveSelectVel').value;
            if (slave === '') {
                log('Please select a slave first', 'err');
                return;
            }
            const speed = Math.round(parseFloat(document.getElementById('pvSpeed').value) * 1000);
            sendCmd('velocity_backward', { slave: parseInt(slave), speed: speed });
            log(`Slave #${parseInt(slave) + 1} Backward: ${speed} units/s`, 'com');
        }

        // Position limit functions for loop tests
        function applyLoopTestPosLimit() {
            const limitChecked = document.getElementById('loopTestPosLimit').checked;
            if (limitChecked) {
                let pos1 = parseFloat(document.getElementById('loopTestPos1').value) || 0;
                let pos2 = parseFloat(document.getElementById('loopTestPos2').value) || 0.035;
                pos1 = Math.max(0, Math.min(0.035, pos1));
                pos2 = Math.max(0, Math.min(0.035, pos2));
                document.getElementById('loopTestPos1').value = pos1;
                document.getElementById('loopTestPos2').value = pos2;
            }
        }

        function applyMultiLoopPosLimit() {
            const limitChecked = document.getElementById('multiLoopPosLimit').checked;
            if (limitChecked) {
                let pos1 = parseFloat(document.getElementById('multiLoopPos1').value) || 0;
                let pos2 = parseFloat(document.getElementById('multiLoopPos2').value) || 0.035;
                pos1 = Math.max(0, Math.min(0.035, pos1));
                pos2 = Math.max(0, Math.min(0.035, pos2));
                document.getElementById('multiLoopPos1').value = pos1;
                document.getElementById('multiLoopPos2').value = pos2;
            }
        }

        // Loop Test Functions
        function startLoopTest() {
            const slave = document.getElementById('loopTestSlaveSelect').value;
            if (slave === '') {
                log('Please select a slave for loop test', 'err');
                return;
            }

            // Apply position limits if enabled
            applyLoopTestPosLimit();

            let pos1 = parseFloat(document.getElementById('loopTestPos1').value);
            let pos2 = parseFloat(document.getElementById('loopTestPos2').value);
            const cycles = parseInt(document.getElementById('loopTestCycles').value) || 0;
            const startDelay = parseFloat(document.getElementById('loopTestStartDelay').value) || 0;
            const stopDelay = parseFloat(document.getElementById('loopTestStopDelay').value) || 0;

            if (isNaN(pos1) || isNaN(pos2)) {
                log('Invalid position values', 'err');
                return;
            }

            if (pos1 === pos2) {
                log('Position 1 and Position 2 must be different', 'err');
                return;
            }

            // Get PV speed from the speed block
            const speedUnit = parseFloat(document.getElementById('pvSpeed').value) || 1;
            const velocity = Math.round(speedUnit * 1000);

            // Apply PV speed first
            applyPVSpeed();

            // Start loop test
            loopTestRunning = true;
            loopTestCurrentCycle = 0;
            loopTestTargetCycles = cycles;
            loopTestDirection = 'forward';
            loopTestSelectedSlave = parseInt(slave);

            // Update UI
            document.getElementById('loopTestStartBtn').disabled = true;
            document.getElementById('loopTestStopBtn').disabled = false;
            document.getElementById('loopTestStatus').style.display = 'block';
            document.getElementById('loopTestLiveStatus').style.display = 'block';
            updateLoopTestStatus('Running', 0);
            updateLoopTestLiveDisplay('Starting...', '---', 0, cycles);

            // Send command to backend with speed and delays
            sendCmd('loop_test_start', {
                slave: parseInt(slave),
                pos1: pos1,
                pos2: pos2,
                cycles: cycles,
                speed: velocity,
                start_delay: startDelay,
                stop_delay: stopDelay
            });

            log(`Loop Test started: Slave #${parseInt(slave) + 1}, ${pos1}m ↔ ${pos2}m, ${cycles === 0 ? 'infinite' : cycles} cycles, delays: ${startDelay}s/${stopDelay}s`, 'com');
        }

        function stopLoopTest() {
            loopTestRunning = false;

            // Clear delay timer
            if (loopTestDelayTimer) {
                clearInterval(loopTestDelayTimer);
                loopTestDelayTimer = null;
            }

            // Send stop command
            sendCmd('loop_test_stop');
            sendCmd('stop');  // Also send general stop

            // Update UI
            updateLoopTestStartBtn();
            document.getElementById('loopTestStopBtn').disabled = true;
            updateLoopTestStatus('Stopped', loopTestCurrentCycle);
            updateLoopTestLiveDisplay('Stopped', '---', loopTestCurrentCycle, loopTestTargetCycles);

            log('Loop Test stopped', 'wrn');
        }

        function updateLoopTestStartBtn() {
            const slave = document.getElementById('loopTestSlaveSelect').value;
            const startBtn = document.getElementById('loopTestStartBtn');
            // Enable start button only if slave is selected and not currently running
            startBtn.disabled = (slave === '' || loopTestRunning);
        }

        function updateLoopTestStatus(status, cycle) {
            const statusText = document.getElementById('loopTestStatusText');
            const cycleCount = document.getElementById('loopTestCycleCount');

            if (statusText) {
                statusText.textContent = status;
                statusText.style.color = status === 'Running' ? 'var(--accent-green)' :
                                         status === 'Stopped' ? 'var(--accent-red)' : 'var(--text-secondary)';
            }
            if (cycleCount) {
                const targetText = loopTestTargetCycles === 0 ? '∞' : loopTestTargetCycles;
                cycleCount.textContent = `Cycle: ${cycle}/${targetText}`;
            }
        }

        // Update loop test live display
        function updateLoopTestLiveDisplay(action, value, cycle, totalCycles) {
            const actionEl = document.getElementById('loopTestLiveAction');
            const valueEl = document.getElementById('loopTestLiveValue');
            const cycleEl = document.getElementById('loopTestLiveCycle');

            if (actionEl) {
                actionEl.textContent = action;
                // Color based on action type
                if (action.includes('Homing')) {
                    actionEl.style.color = 'var(--accent-purple)';
                    valueEl.style.color = 'var(--accent-green)';
                } else if (action.includes('Moving') || action.includes('Forward') || action.includes('Backward')) {
                    actionEl.style.color = 'var(--accent-blue)';
                    valueEl.style.color = 'var(--accent-green)';
                } else if (action.includes('Wait')) {
                    actionEl.style.color = 'var(--text-gold)';
                    valueEl.style.color = 'var(--text-gold)';
                } else if (action === 'Stopped') {
                    actionEl.style.color = 'var(--accent-red)';
                    valueEl.style.color = 'var(--accent-red)';
                } else if (action === 'Complete') {
                    actionEl.style.color = 'var(--accent-green)';
                    valueEl.style.color = 'var(--accent-green)';
                } else {
                    actionEl.style.color = 'var(--text-secondary)';
                    valueEl.style.color = 'var(--text-secondary)';
                }
            }
            if (valueEl) valueEl.textContent = value;
            if (cycleEl) {
                const targetText = totalCycles === 0 ? '∞' : totalCycles;
                cycleEl.textContent = `Cycle: ${cycle}/${targetText}`;
            }
        }

        // Start delay countdown timer
        function startDelayCountdown(totalDelay) {
            // Clear any existing timer
            if (loopTestDelayTimer) {
                clearInterval(loopTestDelayTimer);
            }

            loopTestDelayRemaining = totalDelay;
            const valueEl = document.getElementById('loopTestLiveValue');

            // Update immediately
            if (valueEl) valueEl.textContent = loopTestDelayRemaining.toFixed(1) + 's';

            // Start countdown
            loopTestDelayTimer = setInterval(() => {
                loopTestDelayRemaining -= 0.1;
                if (loopTestDelayRemaining < 0) loopTestDelayRemaining = 0;
                if (valueEl) valueEl.textContent = loopTestDelayRemaining.toFixed(1) + 's';

                if (loopTestDelayRemaining <= 0) {
                    clearInterval(loopTestDelayTimer);
                    loopTestDelayTimer = null;
                }
            }, 100);
        }

        // Handle loop test updates from backend
        function handleLoopTestUpdate(data) {
            const status = data.status;
            console.log('[Loop Test] Status update:', status, data);

            // Show status display
            const statusDiv = document.getElementById('loopTestStatus');
            const liveStatusDiv = document.getElementById('loopTestLiveStatus');
            if (statusDiv) statusDiv.style.display = 'block';
            if (liveStatusDiv) liveStatusDiv.style.display = 'block';

            // Clear delay timer when not in delay state
            if (status !== 'start_delay' && status !== 'stop_delay') {
                if (loopTestDelayTimer) {
                    clearInterval(loopTestDelayTimer);
                    loopTestDelayTimer = null;
                }
            }

            if (status === 'started') {
                loopTestRunning = true;
                loopTestCurrentCycle = 0;
                loopTestTargetCycles = data.cycles || 0;
                loopTestSelectedSlave = data.slave;
                updateLoopTestStartBtn();
                document.getElementById('loopTestStopBtn').disabled = false;
                updateLoopTestStatus('Starting', 0);
                updateLoopTestLiveDisplay('Starting...', '---', 0, loopTestTargetCycles);
            }
            else if (status === 'homing') {
                loopTestCurrentCycle = 0;
                updateLoopTestStatus('Homing (pos1)', 0);
                updateLoopTestLiveDisplay('Homing (pos1)', '---', 0, loopTestTargetCycles);
            }
            else if (status === 'start_delay') {
                loopTestCurrentCycle = data.current_cycle || loopTestCurrentCycle;
                const delay = data.delay || 0;
                updateLoopTestStatus('Wait (start)', loopTestCurrentCycle);
                updateLoopTestLiveDisplay('Wait (start)', delay.toFixed(1) + 's', loopTestCurrentCycle, loopTestTargetCycles);
                startDelayCountdown(delay);
            }
            else if (status === 'stop_delay') {
                loopTestCurrentCycle = data.current_cycle || loopTestCurrentCycle;
                const delay = data.delay || 0;
                updateLoopTestStatus('Wait (stop)', loopTestCurrentCycle);
                updateLoopTestLiveDisplay('Wait (stop)', delay.toFixed(1) + 's', loopTestCurrentCycle, loopTestTargetCycles);
                startDelayCountdown(delay);
            }
            else if (status === 'moving_forward') {
                loopTestCurrentCycle = data.current_cycle || loopTestCurrentCycle;
                loopTestDirection = 'forward';
                updateLoopTestStatus('Forward →', loopTestCurrentCycle);
                updateLoopTestLiveDisplay('Moving Forward →', '---', loopTestCurrentCycle, loopTestTargetCycles);
            }
            else if (status === 'moving_backward') {
                loopTestCurrentCycle = data.current_cycle || loopTestCurrentCycle;
                loopTestDirection = 'backward';
                updateLoopTestStatus('← Backward', loopTestCurrentCycle);
                updateLoopTestLiveDisplay('← Moving Backward', '---', loopTestCurrentCycle, loopTestTargetCycles);
            }
            else if (status === 'stopped') {
                loopTestRunning = false;
                updateLoopTestStartBtn();
                document.getElementById('loopTestStopBtn').disabled = true;
                updateLoopTestStatus('Stopped', loopTestCurrentCycle);
                updateLoopTestLiveDisplay('Stopped', '---', loopTestCurrentCycle, loopTestTargetCycles);
                log(`Loop Test stopped at cycle ${loopTestCurrentCycle}`, 'sys');
            }
            else if (status === 'completed') {
                loopTestRunning = false;
                loopTestCurrentCycle = data.total_cycles || loopTestCurrentCycle;
                updateLoopTestStartBtn();
                document.getElementById('loopTestStopBtn').disabled = true;
                updateLoopTestStatus('Complete', loopTestCurrentCycle);
                updateLoopTestLiveDisplay('Complete', '✓', loopTestCurrentCycle, loopTestTargetCycles);
                log(`Loop Test complete: ${loopTestCurrentCycle} cycles`, 'sys');
            }
        }

        // ============================================
        // Multi-Slave Loop Test Functions
        // ============================================

        // Update multi-loop slave button grid
        function updateMultiLoopSlaveGrid(count) {
            const grid = document.getElementById('multiLoopSlaveGrid');
            if (!grid) return;

            // Check if count changed
            const currentBtns = grid.querySelectorAll('.slave-btn');
            if (currentBtns.length === count && count > 0) return;

            let html = '';
            for (let i = 0; i < count; i++) {
                const isSelected = multiLoopSelectedSlaves.has(i);
                html += `<button class="slave-btn ${isSelected ? 'selected' : ''}"
                         data-slave="${i}"
                         onclick="toggleMultiLoopSlave(${i})">#${i + 1}</button>`;
            }
            grid.innerHTML = html;

            updateMultiLoopStartBtn();
            updateMultiLoopMonitor();
        }

        // Toggle slave selection
        function toggleMultiLoopSlave(idx) {
            if (multiLoopRunning) return;  // Don't allow changes while running

            if (multiLoopSelectedSlaves.has(idx)) {
                multiLoopSelectedSlaves.delete(idx);
            } else {
                multiLoopSelectedSlaves.add(idx);
            }

            // Update button visual
            const btn = document.querySelector(`.slave-btn[data-slave="${idx}"]`);
            if (btn) {
                btn.classList.toggle('selected', multiLoopSelectedSlaves.has(idx));
            }

            updateMultiLoopStartBtn();
            updateMultiLoopMonitor();
        }

        // Select all slaves
        function selectAllMultiLoopSlaves() {
            if (multiLoopRunning) return;

            const btns = document.querySelectorAll('#multiLoopSlaveGrid .slave-btn');
            btns.forEach(btn => {
                const idx = parseInt(btn.dataset.slave);
                multiLoopSelectedSlaves.add(idx);
                btn.classList.add('selected');
            });

            updateMultiLoopStartBtn();
            updateMultiLoopMonitor();
        }

        // Deselect all slaves
        function deselectAllMultiLoopSlaves() {
            if (multiLoopRunning) return;

            multiLoopSelectedSlaves.clear();
            const btns = document.querySelectorAll('#multiLoopSlaveGrid .slave-btn');
            btns.forEach(btn => btn.classList.remove('selected'));

            updateMultiLoopStartBtn();
            updateMultiLoopMonitor();
        }

        // Update multi-loop start button state
        function updateMultiLoopStartBtn() {
            const startBtn = document.getElementById('multiLoopStartBtn');
            if (startBtn) {
                startBtn.disabled = multiLoopSelectedSlaves.size === 0 || multiLoopRunning;
            }
        }

        // Update multi-loop monitor display
        // Shows: #1  wait  0:05 s  OR  #1  moving  0.0123 m
        function updateMultiLoopMonitor(positions = null) {
            const container = document.getElementById('multiLoopSlaveStatus');
            if (!container) return;

            if (multiLoopSelectedSlaves.size === 0) {
                container.innerHTML = '<div style="color: var(--text-secondary); font-size: 0.75rem; text-align: center;">Select slaves to monitor</div>';
                return;
            }

            let html = '';
            const sortedSlaves = Array.from(multiLoopSelectedSlaves).sort((a, b) => a - b);

            sortedSlaves.forEach(idx => {
                const status = multiLoopSlaveStatus[idx] || 'idle';
                const statusColors = {
                    'idle': 'var(--text-secondary)',
                    'moving': 'var(--accent-blue)',
                    'homing': 'var(--accent-purple)',
                    'wait': 'var(--text-gold)',
                    'done': 'var(--accent-green)'
                };
                const statusLabels = {
                    'idle': 'Idle',
                    'moving': 'Moving',
                    'homing': 'Homing',
                    'wait': 'Wait',
                    'done': 'Done'
                };

                // Determine what to show in the value column
                let valueText = '---';
                let valueColor = 'var(--text-secondary)';

                if (status === 'wait' && multiLoopSlaveDelay[idx]) {
                    // Show delay countdown
                    const delayInfo = multiLoopSlaveDelay[idx];
                    const elapsed = (Date.now() - delayInfo.start) / 1000;
                    const remaining = Math.max(0, delayInfo.duration - elapsed);
                    valueText = `${remaining.toFixed(1)} s`;
                    valueColor = 'var(--text-gold)';
                } else if ((status === 'moving' || status === 'homing') && positions && positions[idx] !== undefined) {
                    // Show position
                    valueText = `${positions[idx].toFixed(4)} m`;
                    valueColor = 'var(--accent-green)';
                } else if (status === 'done') {
                    valueText = 'Done';
                    valueColor = 'var(--accent-green)';
                }

                html += `<div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; margin-bottom: 4px; background: var(--bg-card); border-radius: 4px; border-left: 3px solid ${statusColors[status]};">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-weight: 600; color: var(--accent-purple);">#${idx + 1}</span>
                        <span style="font-size: 0.75rem; color: ${statusColors[status]}; min-width: 50px;">${statusLabels[status]}</span>
                    </div>
                    <div style="font-family: 'Courier New', monospace; font-size: 0.85rem; font-weight: 600; color: ${valueColor};">${valueText}</div>
                </div>`;
            });
            container.innerHTML = html;
        }

        // Start delay countdown for a slave
        function startMultiLoopSlaveDelay(slaveIdx, durationSeconds) {
            multiLoopSlaveDelay[slaveIdx] = {
                start: Date.now(),
                duration: durationSeconds
            };
        }

        // Clear delay for a slave
        function clearMultiLoopSlaveDelay(slaveIdx) {
            delete multiLoopSlaveDelay[slaveIdx];
        }

        // Start multi-loop delay update interval
        function startMultiLoopDelayUpdates() {
            if (multiLoopDelayInterval) clearInterval(multiLoopDelayInterval);
            multiLoopDelayInterval = setInterval(() => {
                if (multiLoopRunning) {
                    updateMultiLoopMonitor();
                }
            }, 100);  // Update every 100ms for smooth countdown
        }

        // Stop multi-loop delay updates
        function stopMultiLoopDelayUpdates() {
            if (multiLoopDelayInterval) {
                clearInterval(multiLoopDelayInterval);
                multiLoopDelayInterval = null;
            }
            multiLoopSlaveDelay = {};
        }

        // Start multi-slave loop test
        function startMultiLoopTest() {
            if (multiLoopSelectedSlaves.size === 0) {
                log('Please select at least one slave', 'err');
                return;
            }

            // Apply position limits if enabled
            applyMultiLoopPosLimit();

            const pos1 = parseFloat(document.getElementById('multiLoopPos1').value);
            const pos2 = parseFloat(document.getElementById('multiLoopPos2').value);
            const cycles = parseInt(document.getElementById('multiLoopCycles').value) || 0;
            const startDelay = parseFloat(document.getElementById('multiLoopStartDelay').value) || 0;
            const stopDelay = parseFloat(document.getElementById('multiLoopStopDelay').value) || 0;

            // Get speed and accel/decel from multi-loop specific inputs
            const speed = Math.round(parseFloat(document.getElementById('multiLoopSpeed').value) * 1000);
            const accDec = Math.round(parseFloat(document.getElementById('multiLoopAccDec').value) * 1000);

            if (pos1 === pos2) {
                log('Position 1 and Position 2 must be different', 'err');
                return;
            }

            multiLoopRunning = true;

            // Initialize slave status
            multiLoopSelectedSlaves.forEach(idx => {
                multiLoopSlaveStatus[idx] = 'idle';
            });

            // Update UI
            document.getElementById('multiLoopStartBtn').disabled = true;
            document.getElementById('multiLoopStopBtn').disabled = false;
            document.getElementById('multiLoopCycleDisplay').style.display = 'block';
            document.getElementById('multiLoopTimingDisplay').style.display = 'block';
            document.getElementById('multiLoopCurrentCycle').textContent = '0';
            document.getElementById('multiLoopTotalCycles').textContent = cycles === 0 ? '∞' : cycles;
            // Reset timing display
            document.getElementById('multiLoopTimePos2').textContent = '--';
            document.getElementById('multiLoopTimePos1').textContent = '--';
            document.getElementById('multiLoopCycleTime').textContent = '--';

            // Disable slave buttons during test
            document.querySelectorAll('#multiLoopSlaveGrid .slave-btn').forEach(btn => {
                btn.style.pointerEvents = 'none';
                btn.style.opacity = '0.7';
            });

            // Start delay update interval
            startMultiLoopDelayUpdates();

            updateMultiLoopMonitor();

            log(`Multi-Slave Loop Test started: ${multiLoopSelectedSlaves.size} slaves, Pos1=${pos1}m, Pos2=${pos2}m, Speed=${speed/1000}m/s, AccDec=${accDec/1000}m/s²`, 'com');

            sendCmd('multi_loop_test_start', {
                slaves: Array.from(multiLoopSelectedSlaves),
                pos1: pos1,
                pos2: pos2,
                cycles: cycles,
                speed: speed,
                acc_dec: accDec,
                start_delay: startDelay,
                stop_delay: stopDelay
            });
        }

        // Stop multi-slave loop test
        function stopMultiLoopTest() {
            multiLoopRunning = false;

            // Stop delay updates
            stopMultiLoopDelayUpdates();

            // Stop all selected slaves
            sendCmd('multi_loop_test_stop');

            // Update UI
            document.getElementById('multiLoopStartBtn').disabled = false;
            document.getElementById('multiLoopStopBtn').disabled = true;

            // Re-enable slave buttons
            document.querySelectorAll('#multiLoopSlaveGrid .slave-btn').forEach(btn => {
                btn.style.pointerEvents = 'auto';
                btn.style.opacity = '1';
            });

            // Reset status
            multiLoopSelectedSlaves.forEach(idx => {
                multiLoopSlaveStatus[idx] = 'idle';
            });
            updateMultiLoopMonitor();

            log('Multi-Slave Loop Test stopped', 'sys');
        }

        // Handle multi-loop test updates from backend
        function handleMultiLoopTestUpdate(data) {
            const status = data.status;
            console.log('[Multi-Loop Test] Status update:', status, data);

            if (status === 'started') {
                multiLoopRunning = true;
                document.getElementById('multiLoopCurrentCycle').textContent = '0';
                document.getElementById('multiLoopTotalCycles').textContent = data.cycles === 0 ? '∞' : data.cycles;
            }
            else if (status === 'cycle_update') {
                document.getElementById('multiLoopCurrentCycle').textContent = data.current_cycle || 0;
            }
            else if (status === 'slave_status') {
                // Update individual slave status
                if (data.slave !== undefined && data.slave_status) {
                    const slaveIdx = data.slave;
                    multiLoopSlaveStatus[slaveIdx] = data.slave_status;

                    // Handle delay timing
                    if (data.slave_status === 'wait' && data.delay_duration !== undefined) {
                        startMultiLoopSlaveDelay(slaveIdx, data.delay_duration);
                    } else {
                        clearMultiLoopSlaveDelay(slaveIdx);
                    }
                    updateMultiLoopMonitor();
                }
            }
            else if (status === 'all_status') {
                // Update all slave statuses
                if (data.slave_statuses) {
                    const hasWait = Object.values(data.slave_statuses).some(st => st === 'wait');

                    Object.entries(data.slave_statuses).forEach(([idx, st]) => {
                        const slaveIdx = parseInt(idx);
                        multiLoopSlaveStatus[slaveIdx] = st;

                        // Handle delay timing for wait status
                        if (st === 'wait' && data.delay_duration !== undefined) {
                            startMultiLoopSlaveDelay(slaveIdx, data.delay_duration);
                        } else if (st !== 'wait') {
                            clearMultiLoopSlaveDelay(slaveIdx);
                        }
                    });
                    updateMultiLoopMonitor();
                }
                if (data.current_cycle !== undefined) {
                    document.getElementById('multiLoopCurrentCycle').textContent = data.current_cycle;
                }
            }
            else if (status === 'timing') {
                // Update timing display
                if (data.timing) {
                    const timing = data.timing;
                    if (timing.pos1_to_pos2 !== undefined) {
                        document.getElementById('multiLoopTimePos2').textContent = timing.pos1_to_pos2.toFixed(3) + 's';
                    }
                    if (timing.pos2_to_pos1 !== undefined) {
                        document.getElementById('multiLoopTimePos1').textContent = timing.pos2_to_pos1.toFixed(3) + 's';
                    }
                    if (timing.cycle_time !== undefined) {
                        document.getElementById('multiLoopCycleTime').textContent = timing.cycle_time.toFixed(3) + 's';
                    }
                    if (timing.current_cycle !== undefined) {
                        document.getElementById('multiLoopCurrentCycle').textContent = timing.current_cycle;
                    }
                }
            }
            else if (status === 'stopped' || status === 'completed') {
                multiLoopRunning = false;

                // Stop delay updates
                stopMultiLoopDelayUpdates();

                document.getElementById('multiLoopStartBtn').disabled = false;
                document.getElementById('multiLoopStopBtn').disabled = true;

                // Re-enable slave buttons
                document.querySelectorAll('#multiLoopSlaveGrid .slave-btn').forEach(btn => {
                    btn.style.pointerEvents = 'auto';
                    btn.style.opacity = '1';
                });

                // Mark all as done
                multiLoopSelectedSlaves.forEach(idx => {
                    multiLoopSlaveStatus[idx] = 'done';
                });
                updateMultiLoopMonitor();

                if (status === 'completed') {
                    document.getElementById('multiLoopCurrentCycle').textContent = data.total_cycles || '?';
                    log(`Multi-Slave Loop Test complete: ${data.total_cycles} cycles`, 'sys');
                } else {
                    log(`Multi-Slave Loop Test stopped at cycle ${data.current_cycle || '?'}`, 'sys');
                }
            }
        }

        // Homing functions
        function setHome() {
            const slave = document.getElementById('homeSlaveSelect').value;
            if (slave === '') {
                log('Please select a slave first', 'err');
                return;
            }
            sendCmd('set_home', { slave: parseInt(slave) });
            log(`Setting home for Slave #${parseInt(slave) + 1}`, 'com');
        }

        function setHomeAll() {
            sendCmd('set_home_all');
            log('Setting home for all slaves', 'com');
        }

        // Clear error
        function clearError() {
            const slave = document.getElementById('clearErrorSlaveSelect').value;
            if (slave === '') {
                log('Please select a slave first', 'err');
                return;
            }
            sendCmd('clear_error', { slave: parseInt(slave) });
            log(`Clearing error for Slave #${parseInt(slave) + 1}`, 'com');
        }

        // Speed functions
        function updatePPEffective() {
            const speed = parseFloat(document.getElementById('ppSpeed').value) || 80;
            const velocity = Math.round(speed * 1000);
            const accel = Math.round(speed * 500);
            document.getElementById('ppEffectiveVel').textContent = velocity.toLocaleString();
            document.getElementById('ppEffectiveAccel').textContent = accel.toLocaleString();
        }

        function updateCSPEffective() {
            const maxStep = parseInt(document.getElementById('cspMaxStep').value) || 800;
            document.getElementById('cspEffectiveVel').textContent = (maxStep * 1000).toLocaleString();
        }

        function updatePVEffective(applyLimit = false) {
            const input = document.getElementById('pvSpeed');
            const limitChecked = document.getElementById('pvSpeedLimit').checked;
            let speed = parseFloat(input.value);

            // Handle empty or invalid input
            if (isNaN(speed)) {
                speed = 1;
            }

            // Only apply limit when explicitly requested (on blur) or checkbox changed
            if (applyLimit && limitChecked) {
                if (speed < 0) speed = 0;
                if (speed > 5) speed = 5;
                input.value = speed;
            }

            // For display, use clamped value if limit is checked
            let displaySpeed = speed;
            if (limitChecked) {
                displaySpeed = Math.max(0, Math.min(5, speed));
            }

            const velocity = Math.round(displaySpeed * 1000);
            const accel = Math.round(displaySpeed * 500);
            document.getElementById('pvEffectiveVel').textContent = velocity.toLocaleString();
            document.getElementById('pvEffectiveAccel').textContent = accel.toLocaleString();
        }

        function applyPPSpeed() {
            const speedUnit = parseFloat(document.getElementById('ppSpeed').value) || 80;
            const velocity = Math.round(speedUnit * 1000);
            const acceleration = Math.round(velocity / 2);
            sendCmd('set_speed', { velocity: velocity, acceleration: acceleration, deceleration: acceleration });
            log(`PP Speed applied: Vel=${velocity}, Accel=${acceleration}`, 'sys');
        }

        function applyCSPSpeed() {
            const maxStep = parseInt(document.getElementById('cspMaxStep').value) || 800;
            sendCmd('set_csp_max_step', { max_step: maxStep });
            log(`CSP Max Step applied: ${maxStep} units/ms`, 'sys');
        }

        // Observed speed correction ratio (persisted in sessionStorage)
        let speedCorrectionRatio = parseFloat(sessionStorage.getItem('speedCorrectionRatio')) || 0;

        function calcSpeedFromTime() {
            const distance = parseFloat(document.getElementById('timeDist').value) || 1;
            const duration = parseFloat(document.getElementById('timeDuration').value) || 10;
            const stepsPerMeter = parseInt(document.getElementById('actualStepsInput').value) || 792914;

            const totalSteps = distance * stepsPerMeter;
            const totalMs = duration * 1000;
            const theoreticalVel = Math.round(totalSteps / totalMs);

            document.getElementById('calcCspVelTheory').textContent = theoreticalVel.toLocaleString();
            document.getElementById('calcStepsRef').textContent = stepsPerMeter.toLocaleString();

            // Apply correction ratio if observed
            if (speedCorrectionRatio > 0) {
                const correctedVel = Math.round(theoreticalVel * speedCorrectionRatio);
                document.getElementById('calcCspVel').textContent = correctedVel.toLocaleString();
                document.getElementById('calcRatioUsed').textContent = speedCorrectionRatio;
                document.getElementById('correctedSpeedRow').style.display = 'block';
            } else {
                document.getElementById('correctedSpeedRow').style.display = 'none';
            }
        }

        function applySpeedFromTime() {
            const distance = parseFloat(document.getElementById('timeDist').value) || 1;
            const duration = parseFloat(document.getElementById('timeDuration').value) || 10;
            const stepsPerMeter = parseInt(document.getElementById('actualStepsInput').value) || 792914;

            const totalSteps = distance * stepsPerMeter;
            const totalMs = duration * 1000;
            const theoreticalVel = Math.round(totalSteps / totalMs);

            // Use corrected speed if ratio is available, otherwise theoretical
            const vel = speedCorrectionRatio > 0
                ? Math.max(1, Math.round(theoreticalVel * speedCorrectionRatio))
                : Math.max(1, theoreticalVel);

            // Update CSP Max Step input to match
            document.getElementById('cspMaxStep').value = vel;
            updateCSPEffective();

            // Apply to servo (slave 0)
            sendCmd('set_csp_max_step', { max_step: vel });
            const label = speedCorrectionRatio > 0 ? `(corrected ×${speedCorrectionRatio})` : '(theoretical)';
            log(`Speed from time: ${distance}m in ${duration}s → ${vel} units/ms ${label}`, 'sys');
        }

        function observeSpeed() {
            const btn = document.getElementById('observeSpeedBtn');
            const statusEl = document.getElementById('observeStatus');
            const result = document.getElementById('observeResult');

            btn.disabled = true;
            btn.textContent = 'Testing... (moving servo)';
            statusEl.style.display = 'block';
            result.style.display = 'none';

            sendCmd('observe_speed', {});
        }

        function handleObserveSpeedResult(d) {
            const btn = document.getElementById('observeSpeedBtn');
            const statusEl = document.getElementById('observeStatus');
            const result = document.getElementById('observeResult');

            btn.disabled = false;
            btn.textContent = 'Run Speed Test';
            statusEl.style.display = 'none';

            document.getElementById('obsDistance').textContent = d.distance_m;
            document.getElementById('obsTime').textContent = d.elapsed_s;
            document.getElementById('obsRatio').textContent = d.ratio;
            document.getElementById('obsRatio2').textContent = d.ratio;
            result.style.display = 'block';

            // Store ratio and recalculate speed from time
            speedCorrectionRatio = d.ratio;
            sessionStorage.setItem('speedCorrectionRatio', d.ratio);
            calcSpeedFromTime();

            log(`Speed test: ${d.distance_m}m in ${d.elapsed_s}s | Ratio: ${d.ratio}x | Now applied to time calculator`, 'sys');
        }

        function applyPVSpeed() {
            const limitChecked = document.getElementById('pvSpeedLimit').checked;
            let speedUnit = parseFloat(document.getElementById('pvSpeed').value) || 1;

            // Apply limit if checkbox is checked
            if (limitChecked) {
                if (speedUnit < 0) speedUnit = 0;
                if (speedUnit > 5) speedUnit = 5;
                document.getElementById('pvSpeed').value = speedUnit;
            }

            const velocity = Math.round(speedUnit * 1000);
            const acceleration = Math.round(velocity / 2);
            sendCmd('set_speed', { velocity: velocity, acceleration: acceleration, deceleration: acceleration });
            log(`PV Speed applied: Vel=${velocity}, Accel=${acceleration}`, 'sys');
        }

        // Store loaded config globally
        let loadedConfig = null;

        // Template functions
        async function refreshConfigList() {
            // Try HTTP API first (more reliable), fallback to WebSocket
            try {
                const response = await fetch('/api/configs');
                const data = await response.json();
                if (data.config_files) {
                    updateConfigList(data.config_files);
                } else {
                    log('No config files found', 'wrn');
                }
            } catch (e) {
                // Fallback to WebSocket command
                console.log('HTTP API failed, trying WebSocket:', e);
                sendCmd('list_configs');
            }
        }

        function updateConfigList(files) {
            const select = document.getElementById('configFileName');
            const connectedSlaves = lastNumSlaves || 0;
            let html = '<option value="">-- Select Config --</option>';
            let matchCount = 0;
            files.forEach(f => {
                // Support both new format {filename, slave_count} and legacy string format
                const filename = typeof f === 'string' ? f : f.filename;
                const slaveCount = typeof f === 'string' ? 0 : (f.slave_count || 0);
                // Skip config.json (system config, not a template)
                if (filename === 'config.json') return;
                // Only show configs whose slave count matches connected slaves
                if (connectedSlaves > 0 && slaveCount > 0 && slaveCount !== connectedSlaves) return;
                html += `<option value="${filename}">${filename}${slaveCount ? ' (' + slaveCount + 's)' : ''}</option>`;
                matchCount++;
            });
            select.innerHTML = html;
            log(`Config list: ${matchCount} matching files (${connectedSlaves} slave${connectedSlaves !== 1 ? 's' : ''} connected)`, 'sys');
            // Restore pending config filename from cache
            if (select.dataset.pendingValue) {
                const pending = select.dataset.pendingValue;
                delete select.dataset.pendingValue;
                for (let i = 0; i < select.options.length; i++) {
                    if (select.options[i].value === pending) {
                        select.value = pending;
                        break;
                    }
                }
            }
        }

        // Restore config from status template_filename (on page load when backend is already running)
        async function restoreLoadedConfig(filename) {
            const select = document.getElementById('configFileName');
            const trySelect = () => {
                for (let i = 0; i < select.options.length; i++) {
                    if (select.options[i].value === filename) {
                        select.value = filename;
                        return true;
                    }
                }
                return false;
            };
            // Config list refresh runs 500ms after ws.onopen, wait for it if not populated yet
            if (!trySelect()) {
                await new Promise(r => setTimeout(r, 800));
                trySelect();
            }
            sendCmd('load_config', { filename: filename });
            log(`Restoring config: ${filename}`, 'sys');
        }

        async function restoreLoadedConfigFromDefault() {
            try {
                const resp = await fetch('/api/default_template');
                const data = await resp.json();
                if (data.default_template) {
                    restoreLoadedConfig(data.default_template);
                }
            } catch (e) {
                log('Could not fetch default template for restore', 'wrn');
            }
        }

        function loadConfigFile() {
            const filename = document.getElementById('configFileName').value;
            if (!filename) {
                log('Please select a config file', 'err');
                return;
            }
            sendCmd('load_config', { filename: filename });
            log(`Loading config: ${filename}`, 'com');
        }

        async function setAsDefaultTemplate() {
            const filename = document.getElementById('configFileName').value;
            if (!filename) {
                log('Please select a config file first', 'err');
                return;
            }
            try {
                const resp = await fetch('/api/default_template', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ default_template: filename })
                });
                const result = await resp.json();
                if (result.success) {
                    log(`Default template set to: ${filename}`, 'sys');
                } else {
                    log(`Failed to set default: ${result.message}`, 'err');
                }
            } catch (e) {
                log(`Error setting default template: ${e.message}`, 'err');
            }
        }

        function updateConfigInfo(config) {
            loadedConfig = config;

            // Show config info panel
            const configInfo = document.getElementById('configInfo');
            if (configInfo) {
                configInfo.style.display = 'block';
            }

            // Update config info fields - support both old (settings) and new (slaves/speed) formats
            const slaves = config.slaves || {};
            const speed = config.speed || {};
            const template = config.template || {};
            const positions = config.positions || {};

            document.getElementById('cfgOpMode').textContent = template.operation_mode || 'both';
            document.getElementById('cfgSlaveCount').textContent = slaves.count || '--';

            // Movement slaves
            const movementSlaves = slaves.movement_slaves || [];
            document.getElementById('cfgMovementSlaves').textContent = movementSlaves.length > 0 ? movementSlaves.map(s => `#${s+1}`).join(', ') : '--';

            // Rotation slaves
            const rotationSlaves = slaves.rotation_slaves || [];
            document.getElementById('cfgRotationSlaves').textContent = rotationSlaves.length > 0 ? rotationSlaves.map(s => `#${s+1}`).join(', ') : '--';

            // Speeds - support both formats
            const movementSpeed = speed.movement_speed || {};
            const rotationSpeed = speed.rotation_speed || {};
            document.getElementById('cfgMovementSpeed').textContent = movementSpeed.velocity ? `${movementSpeed.velocity} u/s` : '--';
            document.getElementById('cfgRotationSpeed').textContent = rotationSpeed.velocity ? `${rotationSpeed.velocity} u/s` : '--';

            // Global settings from template
            const isGlobal = template.is_global !== false;  // Default true
            const isSimultaneous = template.is_simultaneous !== false;  // Default true
            const slaveDelayMs = template.slave_delay_ms || 0;

            document.getElementById('cfgIsGlobal').textContent = isGlobal ? 'Yes' : 'No (per-step)';
            document.getElementById('cfgIsGlobal').style.color = isGlobal ? 'var(--accent-green)' : 'var(--accent-purple)';

            if (isGlobal) {
                document.getElementById('cfgMovementMode').textContent = isSimultaneous ? 'Simultaneous' : `Staggered (${slaveDelayMs}ms)`;
            } else {
                document.getElementById('cfgMovementMode').textContent = 'Per-step';
            }

            // Update template display
            updateTemplateDisplay(template, positions, isGlobal);

            log(`Config loaded: ${template.name || 'Unknown'}`, 'sys');
            saveStateCache();
        }

        function updateTemplateDisplay(template, positions, isGlobal = true) {
            const nameEl = document.getElementById('templateName');
            const tbody = document.getElementById('templateTableBody');
            const thead = document.querySelector('#templateTable thead tr');

            // Update table header based on is_global
            if (!isGlobal) {
                thead.innerHTML = `
                    <th style="width: 30px; padding: 6px 4px;">#</th>
                    <th style="padding: 6px 4px;">Name</th>
                    <th style="width: 70px; padding: 6px 4px;">Type</th>
                    <th style="width: 100px; padding: 6px 4px;">Mode</th>
                    <th style="padding: 6px 4px;">Position</th>
                    <th style="width: 50px; padding: 6px 4px;">Delay</th>
                    <th style="width: 130px; padding: 6px 4px;">Time</th>
                    <th style="width: 80px; padding: 6px 4px;">Order</th>
                `;
            } else {
                thead.innerHTML = `
                    <th style="width: 30px; padding: 6px 4px;">#</th>
                    <th style="padding: 6px 4px;">Name</th>
                    <th style="width: 70px; padding: 6px 4px;">Type</th>
                    <th style="padding: 6px 4px;">Position</th>
                    <th style="width: 50px; padding: 6px 4px;">Delay</th>
                    <th style="width: 130px; padding: 6px 4px;">Time</th>
                    <th style="width: 80px; padding: 6px 4px;">Order</th>
                `;
            }

            const colSpan = isGlobal ? 7 : 8;

            if (!template || !template.steps || template.steps.length === 0) {
                nameEl.textContent = 'No template loaded';
                tbody.innerHTML = `<tr><td colspan="${colSpan}" style="text-align: center; color: var(--text-secondary); padding: 15px;">Load a config file to see steps</td></tr>`;
                return;
            }

            const opMode = template.operation_mode || 'both';
            const globalSimul = template.is_simultaneous !== false;
            const globalDelay = template.slave_delay_ms || 0;
            nameEl.innerHTML = `${template.name || 'SEQUENCE'} <span style="color: var(--text-secondary); font-size: 0.75rem;">(${opMode})</span>`;

            let html = '';
            template.steps.forEach((step, i) => {
                const stepType = step.type || 'all';

                // Resolve position reference
                let positionDisplay = '—';
                const posRef = step.position;
                const posRotRef = step.position_rotation;

                if (posRef && positions && positions[posRef]) {
                    positionDisplay = `[${positions[posRef].join(', ')}]`;
                } else if (posRef) {
                    positionDisplay = posRef;
                }

                // For 'all' type, show both positions
                if (stepType === 'all' && posRotRef && positions && positions[posRotRef]) {
                    positionDisplay += ` / [${positions[posRotRef].join(', ')}]`;
                } else if (stepType === 'all' && posRotRef) {
                    positionDisplay += ` / ${posRotRef}`;
                }

                const typeColor = stepType === 'movement' ? 'var(--accent-green)' :
                                  stepType === 'rotation' ? 'var(--accent-blue)' :
                                  stepType === 'home' ? 'var(--accent-red)' : 'var(--text-gold)';
                const typeLabel = stepType.charAt(0).toUpperCase() + stepType.slice(1);

                // Get timing info if available
                const timing = stepTimings[i + 1];
                let timeDisplay = '—';
                let timeColor = 'var(--text-secondary)';
                if (timing && timing.elapsed !== undefined) {
                    timeDisplay = timing.elapsed.toFixed(1) + 's';
                    timeColor = 'var(--accent-green)';
                }

                // Mode column for per-step settings
                let modeColumn = '';
                if (!isGlobal) {
                    const stepSimul = step.is_simultaneous !== undefined ? step.is_simultaneous : globalSimul;
                    const stepDelay = step.slave_delay_ms !== undefined ? step.slave_delay_ms : globalDelay;
                    const stepMoveOrder = step.move_order || 'dynamic';
                    const stepMoveOrderList = step.move_order_list || [];

                    let modeText = stepSimul ? 'Simul' : `Stag(${stepDelay}ms)`;
                    let modeColor = stepSimul ? 'var(--accent-green)' : 'var(--accent-purple)';

                    // Add move order info for staggered mode
                    let orderText = '';
                    if (!stepSimul) {
                        if (stepMoveOrder === 'define' && stepMoveOrderList.length > 0) {
                            orderText = ` [${stepMoveOrderList.map(s => s+1).join('→')}]`;
                        } else {
                            orderText = ' [auto]';
                        }
                    }

                    modeColumn = `<td style="padding: 6px 4px; color: ${modeColor};" title="${stepMoveOrder === 'define' ? 'User-defined order' : 'Dynamic order'}">${modeText}${orderText}</td>`;
                }

                html += `<tr id="step-row-${i + 1}">
                    <td style="padding: 6px 4px;">${i + 1}</td>
                    <td style="padding: 6px 4px;">${step.name || 'Step'}</td>
                    <td style="padding: 6px 4px; color: ${typeColor};">${typeLabel}</td>
                    ${modeColumn}
                    <td style="padding: 6px 4px;">${positionDisplay}</td>
                    <td style="padding: 6px 4px;">${step.delay || 0}s</td>
                    <td style="padding: 6px 4px; color: ${timeColor}; font-weight: bold;" id="step-time-${i + 1}">${timeDisplay}</td>
                    <td style="padding: 6px 4px; color: var(--text-secondary);" id="step-order-${i + 1}">—</td>
                </tr>`;
            });
            tbody.innerHTML = html;

            log(`Template: ${template.name} (${template.steps.length} steps)`, 'sys');
        }

        // Start tracking time for a step
        function startStepTimer(stepIndex) {
            // Stop previous timer if any
            stopStepTimer();

            currentStepIndex = stepIndex;
            stepTimings[stepIndex] = { startTime: Date.now(), elapsed: 0 };

            // Highlight current step row
            const row = document.getElementById(`step-row-${stepIndex}`);
            if (row) {
                row.style.background = 'rgba(88, 166, 255, 0.15)';
                row.style.borderLeft = '3px solid var(--accent-blue)';
            }

            // Update time cell to show running
            const timeCell = document.getElementById(`step-time-${stepIndex}`);
            if (timeCell) {
                timeCell.style.color = 'var(--accent-blue)';
                timeCell.textContent = '0.0s';
            }

            // Start real-time timer update
            stepTimerInterval = setInterval(() => {
                if (stepTimings[stepIndex]) {
                    const elapsed = (Date.now() - stepTimings[stepIndex].startTime) / 1000;
                    stepTimings[stepIndex].elapsed = elapsed;

                    const timeCell = document.getElementById(`step-time-${stepIndex}`);
                    if (timeCell) {
                        timeCell.textContent = elapsed.toFixed(1) + 's';
                    }
                }
            }, 100);  // Update every 100ms
        }

        // Stop the current step timer
        function stopStepTimer() {
            if (stepTimerInterval) {
                clearInterval(stepTimerInterval);
                stepTimerInterval = null;
            }

            if (currentStepIndex) {
                // Remove highlight from previous step
                const row = document.getElementById(`step-row-${currentStepIndex}`);
                if (row) {
                    row.style.background = '';
                    row.style.borderLeft = '';
                }
            }
        }

        // Complete a step and record final time
        function completeStepTimer(stepIndex, totalTime, movementTime, delay) {
            stopStepTimer();

            if (stepTimings[stepIndex]) {
                stepTimings[stepIndex].elapsed = totalTime;
            } else {
                stepTimings[stepIndex] = { elapsed: totalTime };
            }

            // Update time cell with breakdown: total (movement + delay)
            const timeCell = document.getElementById(`step-time-${stepIndex}`);
            if (timeCell) {
                timeCell.style.color = 'var(--accent-green)';
                if (movementTime !== undefined && delay !== undefined) {
                    const mt = movementTime.toFixed(1);
                    const dl = parseFloat(delay).toFixed(1);
                    timeCell.textContent = `${totalTime.toFixed(1)}s (${mt}+${dl})`;
                    timeCell.title = `Total: ${totalTime.toFixed(1)}s | Movement: ${mt}s | Delay: ${dl}s`;
                } else {
                    timeCell.textContent = totalTime.toFixed(1) + 's';
                }
            }

            // Mark row as completed
            const row = document.getElementById(`step-row-${stepIndex}`);
            if (row) {
                row.style.background = 'rgba(63, 185, 80, 0.1)';
                row.style.borderLeft = '3px solid var(--accent-green)';
            }

            currentStepIndex = null;
        }

        // Reset all step timings (when starting new template run)
        function resetStepTimings() {
            stopStepTimer();
            stepTimings = {};
            currentStepIndex = null;

            // Reset all row styles and time/order displays
            const tbody = document.getElementById('templateTableBody');
            if (tbody) {
                const rows = tbody.querySelectorAll('tr[id^="step-row-"]');
                rows.forEach(row => {
                    row.style.background = '';
                    row.style.borderLeft = '';
                });

                const timeCells = tbody.querySelectorAll('td[id^="step-time-"]');
                timeCells.forEach(cell => {
                    cell.style.color = 'var(--text-secondary)';
                    cell.textContent = '—';
                });

                // Reset order cells
                const orderCells = tbody.querySelectorAll('td[id^="step-order-"]');
                orderCells.forEach(cell => {
                    cell.style.color = 'var(--text-secondary)';
                    cell.textContent = '—';
                });
            }
        }

        // Update move order display for a step
        function updateStepMoveOrder(stepIndex, moveOrder, isSpreading) {
            const orderCell = document.getElementById(`step-order-${stepIndex}`);
            if (!orderCell) return;

            if (!moveOrder || moveOrder.length === 0) {
                orderCell.textContent = '—';
                orderCell.style.color = 'var(--text-secondary)';
                return;
            }

            // Format: "1→2→3→4" with spreading/converging indicator
            const orderStr = moveOrder.map(s => s + 1).join('→');
            const indicator = isSpreading ? '↔' : '→←';

            orderCell.innerHTML = `<span style="color: var(--accent-blue);">${indicator}</span> ${orderStr}`;
            orderCell.style.color = 'var(--text-primary)';
        }

        function applyStepsConfig() {
            const actualSteps = parseInt(document.getElementById('actualStepsInput').value);
            const rawSteps = parseInt(document.getElementById('rawStepsInput').value);
            sendCmd('set_steps_config', { actual_steps: actualSteps, raw_steps: rawSteps });
            log(`Steps config: Actual=${actualSteps}, Raw=${rawSteps}`, 'sys');
        }

        // =============================================
        // Template Editor
        // =============================================
        let tplEditorConfig = null; // Working copy of config being edited

        function openTplEditor() {
            if (!loadedConfig) {
                log('Please load a config file first', 'err');
                return;
            }
            // Deep clone the loaded config
            tplEditorConfig = JSON.parse(JSON.stringify(loadedConfig));
            const tpl = tplEditorConfig.template || {};
            const positions = tplEditorConfig.positions || {};

            // Populate template settings
            document.getElementById('tplEditName').value = tpl.name || '';
            document.getElementById('tplEditOpMode').value = tpl.operation_mode || 'both';
            document.getElementById('tplEditSimultaneous').checked = tpl.is_simultaneous !== false;
            document.getElementById('tplEditSlaveDelay').value = tpl.slave_delay_ms || 0;
            document.getElementById('tplEditIsGlobal').checked = tpl.is_global !== false;

            // Populate speed settings
            const speed = tplEditorConfig.speed || {};
            const movSpeed = speed.movement_speed || {};
            const rotSpeed = speed.rotation_speed || {};
            document.getElementById('tplEditMovVelocity').value = movSpeed.velocity || 0;
            document.getElementById('tplEditMovAccel').value = movSpeed.acceleration || 0;
            document.getElementById('tplEditMovDecel').value = movSpeed.deceleration || 0;
            document.getElementById('tplEditRotVelocity').value = rotSpeed.velocity || 0;
            document.getElementById('tplEditRotAccel').value = rotSpeed.acceleration || 0;
            document.getElementById('tplEditRotDecel').value = rotSpeed.deceleration || 0;
            tplEditorOpModeChanged();

            // Load left/right end positions
            document.getElementById('tplEditLeftEnd').value = tpl.left_end_position !== undefined ? tpl.left_end_position : 2;
            document.getElementById('tplEditRightEnd').value = tpl.right_end_position !== undefined ? tpl.right_end_position : -2;

            // Render positions
            tplEditorRenderPositions(positions);

            // Render steps
            tplEditorRenderSteps(tpl.steps || [], positions);

            // Show filename
            const filename = document.getElementById('configFileName').value || 'unknown';
            document.getElementById('tplEditorSubtitle').textContent = `Editing: ${filename}`;
            document.getElementById('tplEditorStatus').textContent = '';

            document.getElementById('tplEditorOverlay').classList.add('show');
        }

        function closeTplEditor() {
            document.getElementById('tplEditorOverlay').classList.remove('show');
            tplEditorConfig = null;
        }

        function tplEditorOpModeChanged() {
            const mode = document.getElementById('tplEditOpMode').value;
            const showMov = mode === 'movement' || mode === 'both';
            const showRot = mode === 'rotation' || mode === 'both';
            document.getElementById('tplEditMovSpeedRow').style.display = showMov ? 'flex' : 'none';
            document.getElementById('tplEditRotSpeedRow').style.display = showRot ? 'flex' : 'none';
        }

        function tplEditorGetSlaveCount() {
            return tplEditorConfig?.slaves?.count || 0;
        }

        function validatePositionValues(valStr) {
            const slaveCount = tplEditorGetSlaveCount();
            const values = valStr.split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
            const rawParts = valStr.split(',').map(v => v.trim()).filter(v => v !== '');

            if (rawParts.length === 0) return { valid: false, msg: 'Empty' };
            if (rawParts.length !== slaveCount) return { valid: false, msg: `Need ${slaveCount} values, got ${rawParts.length}` };
            if (values.length !== slaveCount) return { valid: false, msg: 'Invalid number(s)' };
            if (slaveCount <= 1) return { valid: true, msg: 'OK' };

            const leftEnd = parseFloat(document.getElementById('tplEditLeftEnd').value);
            const rightEnd = parseFloat(document.getElementById('tplEditRightEnd').value);
            if (isNaN(leftEnd) || isNaN(rightEnd)) return { valid: false, msg: 'Set Left/Right end values' };

            const minBound = Math.min(leftEnd, rightEnd);
            const maxBound = Math.max(leftEnd, rightEnd);

            // Check all values are within bounds
            for (let i = 0; i < values.length; i++) {
                if (values[i] < minBound || values[i] > maxBound) {
                    return { valid: false, msg: `Value ${values[i]} out of range [${minBound}, ${maxBound}]` };
                }
            }

            // Direction must follow left-end → right-end
            if (leftEnd > rightEnd) {
                // Must be non-increasing (left is high, right is low)
                for (let i = 1; i < values.length; i++) {
                    if (values[i] > values[i - 1]) {
                        return { valid: false, msg: `Must decrease: left(${leftEnd}) → right(${rightEnd})` };
                    }
                }
            } else if (leftEnd < rightEnd) {
                // Must be non-decreasing (left is low, right is high)
                for (let i = 1; i < values.length; i++) {
                    if (values[i] < values[i - 1]) {
                        return { valid: false, msg: `Must increase: left(${leftEnd}) → right(${rightEnd})` };
                    }
                }
            }
            // leftEnd === rightEnd: all values must be within bounds (already checked)

            return { valid: true, msg: 'OK' };
        }

        function tplEditorValidatePosition(input) {
            const row = input.closest('.tpl-pos-row');
            const span = row.querySelector('.pos-validation');
            if (!span) return;
            const result = validatePositionValues(input.value.trim());
            span.textContent = result.msg;
            span.className = 'pos-validation ' + (result.valid ? 'valid' : 'invalid');
            input.classList.toggle('pos-invalid', !result.valid);
        }

        function tplEditorValidateAllPositions() {
            document.querySelectorAll('#tplEditPositions .pos-values').forEach(input => {
                tplEditorValidatePosition(input);
            });
        }

        function tplEditorRenderPositions(positions) {
            const container = document.getElementById('tplEditPositions');
            let html = '';
            Object.entries(positions).forEach(([name, values]) => {
                html += `<div class="tpl-pos-row">
                    <input type="text" value="${name}" data-orig-name="${name}" class="tpl-pos-name" placeholder="Position name">
                    <input type="text" class="pos-values" value="${Array.isArray(values) ? values.join(', ') : values}" placeholder="Values (comma separated)" oninput="tplEditorValidatePosition(this)">
                    <span class="pos-validation"></span>
                    <button onclick="this.parentElement.remove()" title="Remove">x</button>
                </div>`;
            });
            container.innerHTML = html;
            // Run initial validation
            setTimeout(() => tplEditorValidateAllPositions(), 0);
        }

        function tplEditorAddPosition() {
            const container = document.getElementById('tplEditPositions');
            const div = document.createElement('div');
            div.className = 'tpl-pos-row';
            div.innerHTML = `
                <input type="text" class="tpl-pos-name" placeholder="Position name">
                <input type="text" class="pos-values" value="0" placeholder="Values (comma separated)" oninput="tplEditorValidatePosition(this)">
                <span class="pos-validation"></span>
                <button onclick="this.parentElement.remove()" title="Remove">x</button>
            `;
            container.appendChild(div);
            tplEditorValidatePosition(div.querySelector('.pos-values'));
        }

        function tplEditorGetPositionNames() {
            const names = [];
            document.querySelectorAll('#tplEditPositions .tpl-pos-name').forEach(input => {
                if (input.value.trim()) names.push(input.value.trim());
            });
            return names;
        }

        function tplEditorRenderSteps(steps, positions) {
            const container = document.getElementById('tplEditSteps');
            const posNames = Object.keys(positions);
            let html = '';
            steps.forEach((step, i) => {
                html += tplEditorStepHTML(i, step, posNames);
            });
            container.innerHTML = html;
        }

        function tplEditorStepHTML(index, step, posNames) {
            const isGlobal = document.getElementById('tplEditIsGlobal').checked;
            const posOptions = posNames.map(p =>
                `<option value="${p}" ${step.position === p ? 'selected' : ''}>${p}</option>`
            ).join('');

            const stepOrder = step.move_order || 'dynamic';
            let perStepFields = '';
            if (!isGlobal) {
                const stepSimul = step.is_simultaneous !== undefined ? step.is_simultaneous : true;
                const stepDelay = step.slave_delay_ms !== undefined ? step.slave_delay_ms : 0;
                perStepFields = `
                    <label style="font-size:0.65rem;color:var(--text-secondary);">Simul</label>
                    <input type="checkbox" class="step-simul" ${stepSimul ? 'checked' : ''} style="width:auto;">
                    <label style="font-size:0.65rem;color:var(--text-secondary);">Delay(ms)</label>
                    <input type="number" class="step-slave-delay" value="${stepDelay}" min="0" style="width:55px;">
                `;
            }
            // move_order is always shown
            perStepFields += `
                <label style="font-size:0.65rem;color:var(--text-secondary);">Order</label>
                <select class="step-order" style="font-size:0.7rem;">
                    <option value="dynamic" ${stepOrder === 'dynamic' ? 'selected' : ''}>Dynamic</option>
                    <option value="define" ${stepOrder === 'define' ? 'selected' : ''}>Define</option>
                </select>
            `;

            return `<div class="tpl-step-card" data-step-index="${index}">
                <span class="tpl-step-num">${index + 1}</span>
                <div class="tpl-step-fields">
                    <input type="text" class="step-name" value="${step.name || ''}" placeholder="Step name">
                    <select class="step-type" style="width:90px;">
                        <option value="home" ${step.type === 'home' ? 'selected' : ''}>Home</option>
                        <option value="movement" ${step.type === 'movement' ? 'selected' : ''}>Movement</option>
                        <option value="rotation" ${step.type === 'rotation' ? 'selected' : ''}>Rotation</option>
                        <option value="all" ${step.type === 'all' ? 'selected' : ''}>All</option>
                    </select>
                    <select class="step-position" style="width:120px;">
                        <option value="">-- Position --</option>
                        ${posOptions}
                    </select>
                    <label style="font-size:0.65rem;color:var(--text-secondary);">Delay(s)</label>
                    <input type="number" class="step-delay" value="${step.delay || 0}" min="0" step="0.5" style="width:55px;">
                    ${perStepFields}
                </div>
                <div class="tpl-step-actions">
                    <button onclick="tplEditorMoveStep(${index}, -1)" title="Move up">^</button>
                    <button onclick="tplEditorMoveStep(${index}, 1)" title="Move down">v</button>
                    <button class="del-btn" onclick="tplEditorRemoveStep(${index})" title="Remove">x</button>
                </div>
            </div>`;
        }

        function tplEditorAddStep() {
            const posNames = tplEditorGetPositionNames();
            const container = document.getElementById('tplEditSteps');
            const index = container.querySelectorAll('.tpl-step-card').length;
            const newStep = { name: 'New Step', type: 'movement', position: posNames[0] || '', delay: 3 };
            const wrapper = document.createElement('div');
            wrapper.innerHTML = tplEditorStepHTML(index, newStep, posNames);
            container.appendChild(wrapper.firstElementChild);
        }

        function tplEditorRemoveStep(index) {
            const container = document.getElementById('tplEditSteps');
            const cards = container.querySelectorAll('.tpl-step-card');
            if (cards[index]) cards[index].remove();
            // Re-number
            tplEditorRenumberSteps();
        }

        function tplEditorMoveStep(index, direction) {
            const container = document.getElementById('tplEditSteps');
            const cards = Array.from(container.querySelectorAll('.tpl-step-card'));
            const targetIndex = index + direction;
            if (targetIndex < 0 || targetIndex >= cards.length) return;

            if (direction === -1) {
                container.insertBefore(cards[index], cards[targetIndex]);
            } else {
                container.insertBefore(cards[targetIndex], cards[index]);
            }
            tplEditorRenumberSteps();
        }

        function tplEditorRenumberSteps() {
            const cards = document.querySelectorAll('#tplEditSteps .tpl-step-card');
            cards.forEach((card, i) => {
                card.dataset.stepIndex = i;
                card.querySelector('.tpl-step-num').textContent = i + 1;
                // Update button onclick indices
                const btns = card.querySelectorAll('.tpl-step-actions button');
                btns[0].setAttribute('onclick', `tplEditorMoveStep(${i}, -1)`);
                btns[1].setAttribute('onclick', `tplEditorMoveStep(${i}, 1)`);
                btns[2].setAttribute('onclick', `tplEditorRemoveStep(${i})`);
            });
        }

        function tplEditorCollectConfig() {
            // Collect positions
            const positions = {};
            document.querySelectorAll('#tplEditPositions .tpl-pos-row').forEach(row => {
                const name = row.querySelector('.tpl-pos-name').value.trim();
                const valStr = row.querySelector('.pos-values').value.trim();
                if (name) {
                    const values = valStr.split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
                    positions[name] = values;
                }
            });

            // Collect template settings
            const isGlobal = document.getElementById('tplEditIsGlobal').checked;
            const opMode = document.getElementById('tplEditOpMode').value;
            const template = {
                name: document.getElementById('tplEditName').value.trim() || 'Unnamed',
                operation_mode: opMode,
                is_global: isGlobal,
                is_simultaneous: document.getElementById('tplEditSimultaneous').checked,
                slave_delay_ms: parseInt(document.getElementById('tplEditSlaveDelay').value) || 0,
                left_end_position: parseFloat(document.getElementById('tplEditLeftEnd').value) || 0,
                right_end_position: parseFloat(document.getElementById('tplEditRightEnd').value) || 0,
                steps: []
            };

            // Collect speed settings
            const speed = {};
            speed.movement_speed = {
                velocity: parseInt(document.getElementById('tplEditMovVelocity').value) || 0,
                acceleration: parseInt(document.getElementById('tplEditMovAccel').value) || 0,
                deceleration: parseInt(document.getElementById('tplEditMovDecel').value) || 0,
                csp_max_step: (tplEditorConfig.speed?.movement_speed?.csp_max_step) || 100
            };
            if (opMode === 'both' || opMode === 'rotation') {
                speed.rotation_speed = {
                    velocity: parseInt(document.getElementById('tplEditRotVelocity').value) || 0,
                    acceleration: parseInt(document.getElementById('tplEditRotAccel').value) || 0,
                    deceleration: parseInt(document.getElementById('tplEditRotDecel').value) || 0,
                    csp_max_step: (tplEditorConfig.speed?.rotation_speed?.csp_max_step) || 50
                };
            }

            // Collect steps
            document.querySelectorAll('#tplEditSteps .tpl-step-card').forEach(card => {
                const fields = card.querySelector('.tpl-step-fields');
                const step = {
                    name: fields.querySelector('.step-name').value.trim() || 'Step',
                    type: fields.querySelector('.step-type').value,
                    position: fields.querySelector('.step-position').value,
                    delay: parseFloat(fields.querySelector('.step-delay').value) || 0
                };

                // move_order is always present
                const orderSelect = fields.querySelector('.step-order');
                if (orderSelect) step.move_order = orderSelect.value;

                if (!isGlobal) {
                    const simulCheck = fields.querySelector('.step-simul');
                    const slaveDelayInput = fields.querySelector('.step-slave-delay');
                    if (simulCheck) step.is_simultaneous = simulCheck.checked;
                    if (slaveDelayInput) step.slave_delay_ms = parseInt(slaveDelayInput.value) || 0;
                }

                template.steps.push(step);
            });

            // Merge back into config
            const config = JSON.parse(JSON.stringify(tplEditorConfig));
            config.speed = speed;
            config.positions = positions;
            config.template = template;
            return config;
        }

        function tplEditorHasValidationErrors() {
            let hasErrors = false;
            document.querySelectorAll('#tplEditPositions .pos-values').forEach(input => {
                const result = validatePositionValues(input.value.trim());
                if (!result.valid) hasErrors = true;
            });
            return hasErrors;
        }

        function applyTplEditorChanges() {
            tplEditorValidateAllPositions();
            if (tplEditorHasValidationErrors()) {
                document.getElementById('tplEditorStatus').textContent = 'Fix position errors before applying';
                document.getElementById('tplEditorStatus').style.color = 'var(--accent-red)';
                return;
            }
            const config = tplEditorCollectConfig();
            loadedConfig = config;
            // Update the UI display
            updateConfigInfo(config);
            document.getElementById('tplEditorStatus').textContent = 'Applied to current session (not saved to file)';
            document.getElementById('tplEditorStatus').style.color = 'var(--accent-blue)';
            log('Template changes applied (in-memory)', 'sys');
        }

        async function saveTplEditorChanges() {
            tplEditorValidateAllPositions();
            if (tplEditorHasValidationErrors()) {
                document.getElementById('tplEditorStatus').textContent = 'Fix position errors before saving';
                document.getElementById('tplEditorStatus').style.color = 'var(--accent-red)';
                return;
            }
            const config = tplEditorCollectConfig();
            const filename = document.getElementById('configFileName').value;
            if (!filename) {
                document.getElementById('tplEditorStatus').textContent = 'No config file selected!';
                document.getElementById('tplEditorStatus').style.color = 'var(--accent-red)';
                return;
            }

            document.getElementById('tplEditorStatus').textContent = 'Saving...';
            document.getElementById('tplEditorStatus').style.color = 'var(--accent-blue)';

            try {
                const resp = await fetch('/api/save_template', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: filename, config: config })
                });
                const result = await resp.json();
                if (result.success) {
                    loadedConfig = config;
                    updateConfigInfo(config);
                    document.getElementById('tplEditorStatus').textContent = `Saved to ${filename}`;
                    document.getElementById('tplEditorStatus').style.color = 'var(--accent-green)';
                    log(`Template saved to ${filename}`, 'sys');
                } else {
                    document.getElementById('tplEditorStatus').textContent = `Error: ${result.message || result.detail}`;
                    document.getElementById('tplEditorStatus').style.color = 'var(--accent-red)';
                }
            } catch (e) {
                document.getElementById('tplEditorStatus').textContent = `Error: ${e.message}`;
                document.getElementById('tplEditorStatus').style.color = 'var(--accent-red)';
            }
        }

        // Re-render steps when is_global changes (to show/hide per-step fields)
        document.getElementById('tplEditIsGlobal').addEventListener('change', function() {
            if (!tplEditorConfig) return;
            // Collect current steps from UI, then re-render
            const config = tplEditorCollectConfig();
            const posNames = Object.keys(config.positions);
            tplEditorRenderSteps(config.template.steps, config.positions);
        });

        function runTemplate() {
            if (!loadedConfig) {
                log('Please load a config file first', 'err');
                return;
            }
            resetStepTimings();  // Reset timings before starting
            sendCmd('template', { config: loadedConfig });
            log(`Running template: ${loadedConfig.template?.name || 'Unnamed'} (single run)...`, 'com');
            setTemplateRunning(true);
        }

        function runTemplateLoop() {
            if (!loadedConfig) {
                log('Please load a config file first', 'err');
                return;
            }
            resetStepTimings();  // Reset timings before starting
            sendCmd('template_loop', { config: loadedConfig });
            log(`Running template: ${loadedConfig.template?.name || 'Unnamed'} (LOOP mode)...`, 'com');
            setTemplateRunning(true);
        }

        // Set template running state and update UI
        function setTemplateRunning(running) {
            isTemplateRunning = running;
            updateTemplateControlsState();
            saveStateCache();
        }

        // Update controls state based on template running
        function updateTemplateControlsState() {
            const dis = isTemplateRunning;

            // --- Mode selector ---
            document.querySelectorAll('.mode-item').forEach(el => {
                el.classList.toggle('disabled', dis);
            });

            // --- Top bar: Set Home / Clear Error ---
            const setHomeBtn = document.getElementById('setHomeBtn');
            const setHomeAllBtn = document.getElementById('setHomeAllBtn');
            const homeSlaveSelect = document.getElementById('homeSlaveSelect');
            const clearErrorBtn = document.getElementById('clearErrorBtn');
            const clearErrorSlaveSelect = document.getElementById('clearErrorSlaveSelect');
            if (setHomeBtn) setHomeBtn.disabled = dis;
            if (setHomeAllBtn) setHomeAllBtn.disabled = dis;
            if (homeSlaveSelect) homeSlaveSelect.disabled = dis;
            if (clearErrorBtn) clearErrorBtn.disabled = dis;
            if (clearErrorSlaveSelect) clearErrorSlaveSelect.disabled = dis;

            // --- PP Mode Controls ---
            const ppSlaveSelect = document.getElementById('slaveSelectPP');
            const ppQuickBtns = document.querySelectorAll('#ppQuickBtns button');
            const executeMovePPBtn = document.getElementById('executeMovePPBtn');
            const allToHomePPBtn = document.getElementById('allToHomePPBtn');
            const targetPositionPP = document.getElementById('targetPositionPP');
            if (ppSlaveSelect) ppSlaveSelect.disabled = dis;
            ppQuickBtns.forEach(btn => { btn.disabled = dis; });
            if (executeMovePPBtn) executeMovePPBtn.disabled = dis;
            if (allToHomePPBtn) allToHomePPBtn.disabled = dis;
            if (targetPositionPP) targetPositionPP.disabled = dis;

            // --- CSP Mode Controls ---
            const cspSlaveSelect = document.getElementById('slaveSelect');
            const cspQuickBtns = document.querySelectorAll('#cspQuickBtns button');
            const executeMoveBtn = document.getElementById('executeMoveBtn');
            const allToHomeBtn = document.getElementById('allToHomeBtn');
            const targetPosition = document.getElementById('targetPosition');
            if (cspSlaveSelect) cspSlaveSelect.disabled = dis;
            cspQuickBtns.forEach(btn => { btn.disabled = dis; });
            if (executeMoveBtn) executeMoveBtn.disabled = dis;
            if (allToHomeBtn) allToHomeBtn.disabled = dis;
            if (targetPosition) targetPosition.disabled = dis;

            // --- PV Mode Controls ---
            const pvSlaveSelect = document.getElementById('slaveSelectVel');
            const velForwardBtn = document.getElementById('velForwardBtn');
            const velBackwardBtn = document.getElementById('velBackwardBtn');
            if (pvSlaveSelect) pvSlaveSelect.disabled = dis;
            if (velForwardBtn) velForwardBtn.disabled = dis;
            if (velBackwardBtn) velBackwardBtn.disabled = dis;

            // --- Template controls (except stop) ---
            const runTemplateBtn = document.querySelector('[onclick="runTemplate()"]');
            const loopTemplateBtn = document.querySelector('[onclick="runTemplateLoop()"]');
            const configFileSelect = document.getElementById('configFileName');
            const loadConfigBtn = document.querySelector('[onclick="loadConfigFile()"]');
            if (runTemplateBtn) runTemplateBtn.disabled = dis;
            if (loopTemplateBtn) loopTemplateBtn.disabled = dis;
            if (configFileSelect) configFileSelect.disabled = dis;
            if (loadConfigBtn) loadConfigBtn.disabled = dis;

            // --- Speed / Steps config ---
            const applyStepsBtn = document.querySelector('[onclick="applyStepsConfig()"]');
            const applyPPSpeedBtn = document.querySelector('[onclick="applyPPSpeed()"]');
            const applyCSPSpeedBtn = document.querySelector('[onclick="applyCSPSpeed()"]');
            const applyPVSpeedBtn = document.querySelector('[onclick="applyPVSpeed()"]');
            if (applyStepsBtn) applyStepsBtn.disabled = dis;
            if (applyPPSpeedBtn) applyPPSpeedBtn.disabled = dis;
            if (applyCSPSpeedBtn) applyCSPSpeedBtn.disabled = dis;
            const applyTimeSpeedBtn = document.querySelector('[onclick="applySpeedFromTime()"]');
            if (applyTimeSpeedBtn) applyTimeSpeedBtn.disabled = dis;
            const observeSpeedBtn = document.getElementById('observeSpeedBtn');
            if (observeSpeedBtn) observeSpeedBtn.disabled = dis;
            if (applyPVSpeedBtn) applyPVSpeedBtn.disabled = dis;
            ['actualStepsInput', 'rawStepsInput', 'ppSpeed', 'cspMaxStep', 'pvSpeed', 'timeDist', 'timeDuration'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.disabled = dis;
            });
            const pvSpeedLimit = document.getElementById('pvSpeedLimit');
            if (pvSpeedLimit) pvSpeedLimit.disabled = dis;

            // --- Loop Test Controls ---
            const loopTestStartBtn = document.getElementById('loopTestStartBtn');
            const loopTestStopBtn = document.getElementById('loopTestStopBtn');
            const loopTestSlaveSelect = document.getElementById('loopTestSlaveSelect');
            if (loopTestStartBtn) loopTestStartBtn.disabled = dis;
            if (loopTestStopBtn) loopTestStopBtn.disabled = dis;
            if (loopTestSlaveSelect) loopTestSlaveSelect.disabled = dis;
            ['loopTestPos1', 'loopTestPos2', 'loopTestStartDelay', 'loopTestStopDelay', 'loopTestCycles'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.disabled = dis;
            });
            const loopTestPosLimit = document.getElementById('loopTestPosLimit');
            if (loopTestPosLimit) loopTestPosLimit.disabled = dis;

            // --- Multi-Loop Test Controls ---
            const multiLoopStartBtn = document.getElementById('multiLoopStartBtn');
            const multiLoopStopBtn = document.getElementById('multiLoopStopBtn');
            if (multiLoopStartBtn) multiLoopStartBtn.disabled = dis;
            if (multiLoopStopBtn) multiLoopStopBtn.disabled = dis;
            ['multiLoopPos1', 'multiLoopPos2', 'multiLoopSpeed', 'multiLoopAccDec',
             'multiLoopStartDelay', 'multiLoopStopDelay', 'multiLoopCycles'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.disabled = dis;
            });
            const multiLoopPosLimit = document.getElementById('multiLoopPosLimit');
            if (multiLoopPosLimit) multiLoopPosLimit.disabled = dis;
            // Multi-loop slave toggle buttons
            document.querySelectorAll('.slave-btn').forEach(btn => { btn.disabled = dis; });
            const selectAllBtn = document.querySelector('[onclick="selectAllMultiLoopSlaves()"]');
            const deselectAllBtn = document.querySelector('[onclick="deselectAllMultiLoopSlaves()"]');
            if (selectAllBtn) selectAllBtn.disabled = dis;
            if (deselectAllBtn) deselectAllBtn.disabled = dis;

            // --- Communication OSC/UDP buttons ---
            const oscConnectBtn = document.getElementById('commOscConnectBtn');
            const oscDisconnectBtn = document.getElementById('commOscDisconnectBtn');
            const udpConnectBtn = document.getElementById('commUdpConnectBtn');
            const udpDisconnectBtn = document.getElementById('commUdpDisconnectBtn');
            if (oscConnectBtn) oscConnectBtn.disabled = dis;
            if (oscDisconnectBtn) oscDisconnectBtn.disabled = dis;
            if (udpConnectBtn) udpConnectBtn.disabled = dis;
            if (udpDisconnectBtn) udpDisconnectBtn.disabled = dis;

            // --- When re-enabling, restore proper button states ---
            if (!dis) {
                updateButtonStates();
            }
        }

        // Terminate program
        function terminateProgram() {
            if (confirm('Are you sure you want to terminate the program?')) {
                isTerminating = true;
                sendCmd('terminate');
                log('Terminating program...', 'wrn');
            }
        }

        // Logging
        function log(msg, type = 'sys') {
            const logWindow = document.getElementById('log-window');
            if (!logWindow) return;

            const time = new Date().toLocaleTimeString();
            const entry = document.createElement('div');
            entry.className = 'log-entry';
            entry.innerHTML = `<span class="log-ts">${time}</span><span class="log-${type}">${msg}</span>`;
            logWindow.appendChild(entry);
            logWindow.scrollTop = logWindow.scrollHeight;
        }

        function clearLogs() {
            document.getElementById('log-window').innerHTML = '';
        }

        // Initialize
        restoreFromCache();  // Instant UI restore from localStorage before WS connects
        loadOscListenerReceiver().finally(() => { attachOscReceiverAutosave(); });
        connectWS();
        updatePPEffective();
        updateCSPEffective();
        updatePVEffective();

        // Load saved speed correction ratio from config.json
        fetch('/api/config').then(r => r.json()).then(cfg => {
            if (cfg.speed_correction && cfg.speed_correction.ratio) {
                speedCorrectionRatio = cfg.speed_correction.ratio;
                sessionStorage.setItem('speedCorrectionRatio', speedCorrectionRatio);
                // Show observe result from saved data
                const d = cfg.speed_correction;
                document.getElementById('obsDistance').textContent = d.distance_m;
                document.getElementById('obsTime').textContent = d.elapsed_s;
                document.getElementById('obsRatio').textContent = d.ratio;
                document.getElementById('obsRatio2').textContent = d.ratio;
                document.getElementById('observeResult').style.display = 'block';
            }
            calcSpeedFromTime();
        }).catch(() => { calcSpeedFromTime(); });