// ========================================================
        // State
        // ========================================================
        let ws = null;
        let reconnectTimer = null;
        let wsTriedAlt = false;
        let wsEverOpened = false;
        let currentPage = 'main';
        let numSlaves = 0;
        let lastNumSlaves = 0;
        let lastWkcMismatch = false;
        let selectedPillar = -1;    // -1 = none selected
        let selectedProduct = 'hmrs_slider';
        let loadedConfig = null;
        let defaultTemplateName = '';
        let templateSlaveCountCache = {};
        let templateSlaveCountCacheLoaded = false;
        let isPatternRunning = false;
        let isFirstStatus = true;
        let slaveDisconnected = false;
        let disconnectedSlaveNum = 0;
        let wkcOkCount = 0;  // Consecutive "no mismatch" polls needed to confirm reconnect
        let totalSlavesBeforeDisconnect = 0;  // Full slave count saved when disconnect first detected
        let hasFault = false;
        let hadFaultPrev = false;
        let reconnectGrace = 0;  // Grace period after reconnect - suppress fault edge detection
        let systemState = 0;
        let latestStatusWords = [];   // Per-slave status words from last status
        let latestErrorCodes = [];    // Per-slave error codes from last status
        let disconnectedCounter = 0;
        let interfaceOverlayShown = false;
        let interfaceOverlayTimer = null;
        let forceInterfaceOverlay = false;
        let wsFailCount = 0;
        let oscSendAddresses = ['/template_step', '/composition/layers/1/clips/{v}/connect'];
        let oscListenerConfig = null;
        let oscMappingEntries = [];
        let oscListenerLastAction = '';
        let oscReceiverEnabled = false;
        let udpConnected = false;
        let udpFormTouched = false;
        let udpInputsBound = false;
        let udpLogEntries = [];
        let loadedConfigFilename = '';
        let pendingLoadConfigFilename = '';
        let pendingRunPattern = false;

        // License UI
        let licenseInfoCache = null;

        function openLicensePage() {
            openLicenseModal();
        }

        function openLicenseModal() {
            const modal = document.getElementById('licenseModal');
            if (!modal) return;
            modal.classList.add('active');
            modal.setAttribute('aria-hidden', 'false');
            toggleLicenseTooltip(false);
            fetchLicenseModalStatus();
        }

        function closeLicenseModal() {
            const modal = document.getElementById('licenseModal');
            if (!modal) return;
            modal.classList.remove('active');
            modal.setAttribute('aria-hidden', 'true');
            hideLicenseLoading();
        }

        function toggleLicenseTooltip(forceState) {
            const tooltip = document.getElementById('licenseTooltip');
            if (!tooltip) return;
            const nextState = typeof forceState === 'boolean' ? forceState : !tooltip.classList.contains('active');
            tooltip.classList.toggle('active', nextState);
        }

        async function refreshLicenseStatus() {
            const badge = document.getElementById('licenseBadge');
            const tooltip = document.getElementById('licenseTooltip');
            if (!badge) return;
            try {
                const res = await fetch('/api/license/status');
                const data = await res.json();
                licenseInfoCache = data || null;
                if (data.valid) {
                    let extra = '';
                    if (data.expiry) {
                        const parts = data.expiry.split('-');
                        if (parts.length === 3) {
                            const expDate = new Date(`${parts[2]}-${parts[0]}-${parts[1]}T00:00:00`);
                            if (!isNaN(expDate.getTime())) {
                                const daysLeft = Math.ceil((expDate - new Date()) / (1000 * 60 * 60 * 24));
                                extra = ` (${daysLeft}d)`;
                            }
                        }
                    }
                    badge.textContent = `License: ${data.expiry || 'N/A'}${extra}`;
                    badge.classList.remove('expired');
                } else {
                    badge.textContent = `License: ${data.reason || 'Invalid'}`;
                    badge.classList.add('expired');
                }

                if (tooltip) {
                    if (data.valid) {
                        tooltip.innerHTML = [
                            `<div class="tip-title">${data.name || 'Licensed User'}</div>`,
                            `<div class="tip-row"><span class="tip-label">Organization</span><span>${data.organization || 'N/A'}</span></div>`,
                            `<div class="tip-row"><span class="tip-label">Issued At</span><span>${data.issued_at || 'N/A'}</span></div>`,
                            `<div class="tip-row"><span class="tip-label">Expiry</span><span>${data.expiry || 'N/A'}</span></div>`
                        ].join('');
                    } else {
                        tooltip.innerHTML = [
                            `<div class="tip-title">License</div>`,
                            `<div class="tip-row"><span class="tip-label">Status</span><span>${data.reason || 'Invalid'}</span></div>`
                        ].join('');
                    }
                }
            } catch (e) {
                badge.textContent = 'License: unknown';
                badge.classList.add('expired');
            }
        }

        async function fetchLicenseModalStatus() {
            const box = document.getElementById('licenseStatusBox');
            if (!box) return;
            try {
                const res = await fetch('/api/license/status');
                const data = await res.json();
                if (data.valid) {
                    box.innerHTML = `<span class="ok">Valid</span> | License ID: ${data.license_id || 'N/A'} | Expires: ${data.expiry || 'N/A'}`;
                } else {
                    box.innerHTML = `<span class="error">Invalid</span> | ${data.reason || 'License required'}`;
                }
            } catch (e) {
                box.innerHTML = `<span class="error">Error</span> | Unable to check license`;
            }
        }

        const LICENSE_STEPS = [
            { id: 'fetch', text: 'Fetching license data', pct: 10 },
            { id: 'verify', text: 'Verifying license', pct: 25 },
            { id: 'success', text: 'License verified successfully', pct: 40 },
            { id: 'restart', text: 'Starting motor server', pct: 55 },
            { id: 'slaves', text: 'Connecting to EtherCAT slaves', pct: 75 },
            { id: 'ready', text: 'Preparing dashboard', pct: 95 },
        ];

        function renderLicenseSteps(activeId) {
            const container = document.getElementById('licenseStepsContainer');
            if (!container) return;
            container.innerHTML = LICENSE_STEPS.map(step => {
                let cls = 'license-step';
                let icon = '<div class="license-spinner"></div>';
                if (activeId === 'done') { cls += ' done'; icon = '&#10003;'; }
                else if (step.id === activeId) { cls += ' active'; icon = '<div class="license-spinner"></div>'; }
                return `<div class="${cls}" id="license-step-${step.id}"><span class="license-step-icon">${icon}</span>${step.text}</div>`;
            }).join('');
        }

        function setLicenseProgress(pct) {
            const fill = document.getElementById('licenseProgressFill');
            const pctEl = document.getElementById('licenseProgressPct');
            if (fill) fill.style.width = pct + '%';
            if (pctEl) pctEl.textContent = pct + '%';
        }

        function showLicenseLoading() {
            const overlay = document.getElementById('licenseLoadingOverlay');
            if (overlay) overlay.classList.add('active');
        }

        function hideLicenseLoading() {
            const overlay = document.getElementById('licenseLoadingOverlay');
            if (overlay) overlay.classList.remove('active');
        }

        async function uploadLicenseFromModal() {
            const fileInput = document.getElementById('licenseFileInput');
            const msg = document.getElementById('licenseMessage');
            const btn = document.getElementById('licenseUploadBtn');
            if (!fileInput || !msg || !btn) return;
            if (!fileInput.files.length) {
                msg.textContent = 'Please select a license file.';
                msg.className = 'license-note error';
                return;
            }

            btn.disabled = true;
            showLicenseLoading();
            renderLicenseSteps('fetch');
            setLicenseProgress(10);

            const file = fileInput.files[0];
            const buf = await file.arrayBuffer();
            const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));

            renderLicenseSteps('verify');
            setLicenseProgress(25);

            try {
                const res = await fetch('/api/license/upload', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data_b64: b64 })
                });
                const data = await res.json();

                if (!data.success) {
                    hideLicenseLoading();
                    msg.textContent = data.error || 'Upload failed.';
                    msg.className = 'license-note error';
                    btn.disabled = false;
                    return;
                }

                renderLicenseSteps('success');
                setLicenseProgress(40);
                renderLicenseSteps('restart');
                setLicenseProgress(55);

                let ready = false;
                for (let i = 0; i < 60; i++) {
                    await new Promise(r => setTimeout(r, 500));
                    try {
                        const r2 = await fetch('/api/license/status?t=' + Date.now());
                        const d = await r2.json();
                        if (d.valid) {
                            try {
                                const r3 = await fetch('/api/status?t=' + Date.now());
                                const st = await r3.json();
                                if (st && typeof st.state !== 'undefined') {
                                    ready = true;
                                    break;
                                }
                            } catch (e) {}
                        }
                    } catch (e) {}
                }

                renderLicenseSteps('slaves');
                setLicenseProgress(75);
                await new Promise(r => setTimeout(r, 1500));
                renderLicenseSteps('ready');
                setLicenseProgress(95);
                await new Promise(r => setTimeout(r, 600));
                renderLicenseSteps('done');
                setLicenseProgress(100);
                const subtitle = document.getElementById('licenseLoadingSubtitle');
                if (subtitle) subtitle.textContent = ready ? 'All set! Reloading...' : 'License updated.';

                await new Promise(r => setTimeout(r, 500));
                hideLicenseLoading();
                closeLicenseModal();
                btn.disabled = false;
                msg.textContent = 'License updated successfully.';
                msg.className = 'license-note ok';
                refreshLicenseStatus();
            } catch (e) {
                hideLicenseLoading();
                msg.textContent = 'Network error: ' + e.message;
                msg.className = 'license-note error';
                btn.disabled = false;
            }
        }

        // License tooltip interactions
        document.addEventListener('click', (e) => {
            const badge = document.getElementById('licenseBadge');
            const tooltip = document.getElementById('licenseTooltip');
            if (!badge || !tooltip) return;
            if (badge.contains(e.target)) {
                toggleLicenseTooltip();
            } else if (!tooltip.contains(e.target)) {
                toggleLicenseTooltip(false);
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const badge = document.getElementById('licenseBadge');
            if (badge && document.activeElement === badge) {
                e.preventDefault();
                toggleLicenseTooltip();
            }
        });

        // Debug panel state
        let debugPanelOpen = false;
        let debugStepTimings = {};
        let debugCurrentStepIndex = null;
        let debugStepTimerInterval = null;
        let debugTemplateSteps = [];
        let tplSpeedTestRunning = false;

        // ========================================================
        // LocalStorage Cache - persist UI state across page reloads
        // ========================================================
        const CACHE_KEY = 'simpleui_state';

        function saveStateCache() {
            try {
                const state = {
                    currentPage,
                    loadedConfig,
                    defaultTemplateName,
                    isPatternRunning,
                    debugTemplateSteps
                };
                localStorage.setItem(CACHE_KEY, JSON.stringify(state));
            } catch (e) { /* ignore storage errors */ }
        }

        function restoreFromCache() {
            try {
                const raw = localStorage.getItem(CACHE_KEY);
                if (!raw) return false;
                const cached = JSON.parse(raw);
                if (!cached || !cached.currentPage || cached.currentPage === 'main') return false;

                // Restore page
                document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
                document.getElementById('page-' + cached.currentPage).classList.add('active');
                currentPage = cached.currentPage;

                // Restore config and template info
                if (cached.loadedConfig) {
                    loadedConfig = cached.loadedConfig;
                    debugTemplateSteps = loadedConfig.template?.steps || [];
                    const name = loadedConfig.template?.name || cached.defaultTemplateName || '';
                    defaultTemplateName = cached.defaultTemplateName || '';
                    const display = document.getElementById('templateNameDisplay');
                    if (display) display.textContent = name || defaultTemplateName.replace('.json', '') || 'Unknown Template';
                }

                // Restore pattern running state (will be validated by first status)
                if (cached.isPatternRunning && currentPage === 'pattern') {
                    isPatternRunning = true;
                    updatePatternUI();
                    setPatternStatus('Template running in loop...', 'running');
                }

                // Render debug template table immediately from cache
                updateDebugTemplateTable();
                return true;
            } catch (e) { return false; }
        }

        // ========================================================
        // Product Configurations (pillar-based)
        // ========================================================
        const PRODUCT_CONFIGS = {
            'hmrs_slider': {
                slavesPerPillar: 1,
                roles: ['Movement'],
                roleSlotCSS: ['movement'],
                isMatrix: false
            },
            'hmrs_both': {
                slavesPerPillar: 2,
                roles: ['Rotation', 'Movement'],  // even=rotation(slot0), odd=movement(slot1)
                roleSlotCSS: ['rotation', 'movement'],
                isMatrix: false
            },
            'matrix_1': {
                slavesPerPillar: 1,
                roles: ['Movement'],
                roleSlotCSS: ['movement'],
                isMatrix: true
            },
            'matrix_2': {
                slavesPerPillar: 2,
                roles: ['Row 1', 'Row 2'],
                roleSlotCSS: ['row1', 'row2'],
                isMatrix: true
            },
            'matrix_3': {
                slavesPerPillar: 3,
                roles: ['Row 1', 'Row 2', 'Row 3'],
                roleSlotCSS: ['row1', 'row2', 'row3'],
                isMatrix: true
            }
        };

        // ========================================================
        // Pillar & Slave Mapping
        // ========================================================
        function getEffectiveSlaveCount() {
            return numSlaves;
        }

        function getNumPillars() {
            const config = PRODUCT_CONFIGS[selectedProduct];
            const count = getEffectiveSlaveCount();
            return Math.ceil(count / config.slavesPerPillar);
        }

        function getSlaveIndex(pillarIdx, roleIdx) {
            const config = PRODUCT_CONFIGS[selectedProduct];
            return pillarIdx * config.slavesPerPillar + roleIdx;
        }

        function getSelectedRoleIndex() {
            const config = PRODUCT_CONFIGS[selectedProduct];
            const movementType = document.getElementById('movementTypeSelect').value;
            return config.roles.indexOf(movementType);
        }

        function getTargetSlaveIndex() {
            if (selectedPillar < 0) return -1;
            const roleIdx = getSelectedRoleIndex();
            if (roleIdx < 0) return -1;
            const slaveIdx = getSlaveIndex(selectedPillar, roleIdx);
            const count = getEffectiveSlaveCount();
            return slaveIdx < count ? slaveIdx : -1;
        }

        // ========================================================
        // Pillar Layout Rendering
        // ========================================================
        function updatePillarLayout() {
            const container = document.getElementById('pillarRow');
            if (!container) return;

            const config = PRODUCT_CONFIGS[selectedProduct];
            const count = getEffectiveSlaveCount();
            const numPillars = getNumPillars();
            const roleIdx = getSelectedRoleIndex();
            const isHMRS = !config.isMatrix;

            if (count === 0) {
                container.innerHTML = '<div class="no-pillars">No motors connected</div>';
                return;
            }

            let html = '';
            for (let p = 0; p < numPillars; p++) {
                const isSelected = (p === selectedPillar);

                if (isHMRS) {
                    // HMRS: single combined button per pillar showing active motor
                    const activeSlaveIdx = getSlaveIndex(p, roleIdx >= 0 ? roleIdx : 0);
                    if (activeSlaveIdx >= count) continue;
                    const roleName = config.roles[roleIdx >= 0 ? roleIdx : 0] || '';
                    const cssClass = config.roleSlotCSS[roleIdx >= 0 ? roleIdx : 0] || '';

                    html += `<div class="pillar pillar-compact ${isSelected ? 'selected' : ''}" onclick="selectPillar(${p})">`;
                    html += `<div class="pillar-label">Pillar ${p + 1}</div>`;
                    html += `<div class="pillar-slots">`;
                    html += `<div class="pillar-slot slot-${cssClass} ${isSelected ? 'target' : ''}"
                                 title="Motor ${activeSlaveIdx} (${roleName})">
                                Pillar ${p + 1} (Motor ${activeSlaveIdx})
                             </div>`;
                    html += '</div></div>';
                } else {
                    // Matrix: show stacked rows per pillar
                    html += `<div class="pillar ${isSelected ? 'selected' : ''}" onclick="selectPillar(${p})">`;
                    html += `<div class="pillar-label">Pillar ${p + 1}</div>`;
                    html += `<div class="pillar-slots">`;

                    for (let r = 0; r < config.slavesPerPillar; r++) {
                        const slaveIdx = getSlaveIndex(p, r);
                        if (slaveIdx >= count) break;

                        const cssClass = config.roleSlotCSS[r] || '';
                        const isActiveSlot = (r === roleIdx);
                        const isTarget = isSelected && isActiveSlot;

                        html += `<div class="pillar-slot slot-${cssClass} ${isTarget ? 'target' : ''}"
                                     title="Motor ${slaveIdx} (${config.roles[r]})">
                                    Motor ${slaveIdx}
                                 </div>`;
                    }

                    html += '</div></div>';
                }
            }

            container.innerHTML = html;
        }

        function selectPillar(index) {
            selectedPillar = (selectedPillar === index) ? -1 : index; // toggle
            updatePillarLayout();
            updatePillarHint();
            updateSpeedInputState();
        }

        // ========================================================
        // Movement Type & Direction Labels
        // ========================================================
        function updateMovementTypeDropdown() {
            const config = PRODUCT_CONFIGS[selectedProduct];
            const select = document.getElementById('movementTypeSelect');
            select.innerHTML = config.roles.map(r =>
                `<option value="${r}">${r}</option>`
            ).join('');
        }

        function updateDirectionLabels() {
            const config = PRODUCT_CONFIGS[selectedProduct];
            const btnLeft = document.getElementById('btnLeft');
            const btnRight = document.getElementById('btnRight');
            if (config.isMatrix) {
                btnLeft.innerHTML = '&#9650; UP';
                btnRight.innerHTML = 'DOWN &#9660;';
            } else {
                btnLeft.innerHTML = '&#9664; LEFT';
                btnRight.innerHTML = 'RIGHT &#9654;';
            }
        }

        function onMovementTypeChange() {
            updatePillarLayout();
            // Auto-check speed limit for HMRS Rotation
            const config = PRODUCT_CONFIGS[selectedProduct];
            const chk = document.getElementById('speedLimitCheck');
            if (chk && !config.isMatrix) {
                const movementType = document.getElementById('movementTypeSelect').value;
                if (movementType === 'Rotation') {
                    chk.checked = true;
                    onSpeedLimitChange();
                }
            }
        }

        const PRODUCT_LABELS = {
            'hmrs_slider': 'HMRS: Slider',
            'hmrs_both': 'HMRS: Movement & Rotation',
            'matrix_1': 'Matrix: One Motor Per Pillar',
            'matrix_2': 'Matrix: Two Motor Per Pillar',
            'matrix_3': 'Matrix: Three Motor Per Pillar'
        };

        function setProduct(productKey) {
            selectedProduct = productKey;
            selectedPillar = -1;

            // Populate dropdown options
            const select = document.getElementById('productSelect');
            if (select) {
                select.innerHTML = Object.entries(PRODUCT_LABELS).map(([key, label]) =>
                    `<option value="${key}" ${key === productKey ? 'selected' : ''}>${label}</option>`
                ).join('');
            }

            updateMovementTypeDropdown();
            updateDirectionLabels();
            updatePillarLayout();
        }

        function changeProductFromDropdown() {
            const select = document.getElementById('productSelect');
            if (!select) return;
            const newProduct = select.value;
            if (!newProduct || newProduct === selectedProduct) return;

            selectedProduct = newProduct;
            selectedPillar = -1;

            updateMovementTypeDropdown();
            updateDirectionLabels();
            updatePillarLayout();
            updatePillarHint();

            // Save product to server
            fetch('/api/product', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ product: newProduct })
            });
        }

        async function fetchProduct() {
            try {
                const resp = await fetch('/api/product');
                const data = await resp.json();
                setProduct(data.product || 'hmrs_slider');
            } catch (e) {
                setProduct('hmrs_slider');
            }
        }

        // ========================================================
        // Velocity Control
        // ========================================================
        function startVelocity(direction) {
            const slaveIdx = getTargetSlaveIndex();
            if (slaveIdx < 0) {
                flashPillarHint();
                return;
            }

            enforceSpeedLimit();
            const sp = getHomeSpeed();
            // Configure drive speed first, then send velocity command
            sendCmd('set_speed', { velocity: sp.velocity, acceleration: sp.acceleration, deceleration: sp.deceleration });
            const cmd = direction === 'forward' ? 'velocity_forward' : 'velocity_backward';
            sendCmd(cmd, { slave: slaveIdx, speed: sp.velocity });
        }

        function flashPillarHint() {
            const hint = document.getElementById('pillarHint');
            if (!hint) return;
            hint.textContent = 'Please select a pillar first!';
            hint.classList.remove('flash');
            void hint.offsetWidth; // force reflow for re-animation
            hint.classList.add('flash');
            setTimeout(() => {
                hint.classList.remove('flash');
                updatePillarHint();
            }, 1500);
        }

        function updatePillarHint() {
            const hint = document.getElementById('pillarHint');
            if (!hint) return;
            if (selectedPillar >= 0) {
                hint.textContent = `Pillar ${selectedPillar + 1} selected`;
                hint.style.color = 'var(--blue)';
            } else {
                hint.textContent = 'Select a pillar to control';
                hint.style.color = '';
            }
        }

        function stopVelocity() {
            sendCmd('velocity_stop', { slave: 'all' });
        }

        function emergencyStop() {
            sendCmd('stop');
            if (isPatternRunning) {
                isPatternRunning = false;
                updatePatternUI();
            }
        }

        function setAllHome() {
            sendCmd('set_home_all');
            // Disable drives and go back to main
            setTimeout(() => {
                sendCmd('disable');
                showPage('main');
                showToast('Home position set successfully!');
            }, 300);
        }

        function showToast(message, type = 'success') {
            const toast = document.getElementById('toastNotification');
            if (!toast) return;
            toast.textContent = message;
            toast.classList.remove('error');
            if (type === 'error') toast.classList.add('error');
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 2500);
        }

        // ========================================================
        // WebSocket
        // ========================================================
        function connectWS(forceHost = null) {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const hostname = window.location.hostname;
            const port = window.location.port ? `:${window.location.port}` : '';
            const defaultHost = (hostname === '0.0.0.0') ? `127.0.0.1${port}` : window.location.host;
            const wsHost = forceHost ? (forceHost + port) : defaultHost;
            const wsUrl = `${protocol}//${wsHost}/ws?page=simpleui`;

            wsEverOpened = false;
            try { ws = new WebSocket(wsUrl); } catch (e) { return; }

            ws.onopen = () => {
                wsEverOpened = true;
                if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
                wsFailCount = 0;
                isFirstStatus = true;  // Re-check state on reconnect
                reconnectGrace = 5;  // Suppress fault edge detection for 5 cycles (~250ms) after reconnect
                slaveDisconnected = false;
                wkcOkCount = 0;
                lastWkcMismatch = false;
                hideDisconnectBanner();
            };

            ws.onclose = () => {
                updateConnectionUI(0);
                if (!wsEverOpened && !wsTriedAlt && hostname !== '127.0.0.1' && hostname !== 'localhost') {
                    wsTriedAlt = true;
                    showToast('WebSocket failed, trying 127.0.0.1...');
                    connectWS('127.0.0.1');
                    return;
                }
                wsFailCount++;
                // If server is gone (multiple failed reconnects), close the tab
                if (wsFailCount >= 5) {
                    try { window.close(); } catch(e) {}
                    // Fallback: show message if window.close() is blocked by browser
                    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:Nunito,sans-serif;color:#7c82a0;font-size:1.2rem;font-weight:700;text-align:center;padding:40px;">Server disconnected.<br>You can close this tab.</div>';
                    return;
                }
                if (!reconnectTimer) {
                    reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWS(); }, 2000);
                }
            };

            ws.onerror = () => {};

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'status') updateStatus(msg.data);
                    else if (msg.type === 'response') handleResponse(msg.data);
                } catch (e) {}
            };
        }

        function sendCmd(cmd, data = null) {
            if (cmd === 'stop' || cmd === 'disable') {
                console.warn(`[sendCmd] ${cmd} called from:`, new Error().stack);
            }
            if (cmd === 'load_config' && data && data.filename) {
                pendingLoadConfigFilename = data.filename;
            }
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ cmd, data }));
            }
        }

        // ========================================================
        // Status Updates
        // ========================================================
        function updateStatus(status) {
            const totalSlaves = status.num_slaves || 0;
            systemState = status.state || 0;
            latestStatusWords = status.status_words || [];
            latestErrorCodes = status.error_codes || [];

            // Compute how many slaves are actually connected right now
            // first_disconnected_slave is 1-indexed; slaves 1..(N-1) are connected before it
            let connectedCount = totalSlaves;
            if (status.wkc_mismatch && status.first_disconnected_slave > 0) {
                connectedCount = status.first_disconnected_slave - 1;
            }
            const newNumSlaves = connectedCount;

            // Auto-restore page on first status after page load/reconnect
            if (isFirstStatus) {
                isFirstStatus = false;
                const cacheRestored = (currentPage !== 'main');  // restoreFromCache already ran

                if (status.state === 2 && !status.has_fault) {
                    if (!cacheRestored) {
                        // No cache - restore from backend status
                        if (status.mode === 3) {
                            restorePage('home');
                        } else if (status.mode === 1) {
                            restorePage('pattern', status.template_filename || '');
                        }
                    }
                    // Validate/sync running state from backend
                    if (status.template_running && !isPatternRunning && currentPage === 'pattern') {
                        isPatternRunning = true;
                        updatePatternUI();
                        setPatternStatus('Template running in loop...', 'running');
                        saveStateCache();
                    } else if (!status.template_running && isPatternRunning) {
                        // Template stopped while page was closed
                        isPatternRunning = false;
                        updatePatternUI();
                        setPatternStatus('Template stopped.', 'stopped');
                        saveStateCache();
                    }
                } else if (cacheRestored) {
                    // Backend is not enabled but cache put us on a page - go back to main
                    isPatternRunning = false;
                    navigateToMain();
                }
            }

            // Use backend-computed has_fault (checks fault bit + known error code)
            hasFault = !!status.has_fault;

            updateConnectionUI(systemState, status.moving);
            updateUdpStatus(status);

            if (newNumSlaves !== lastNumSlaves || (status.wkc_mismatch !== lastWkcMismatch)) {
                lastWkcMismatch = !!status.wkc_mismatch;
                lastNumSlaves = newNumSlaves;
                numSlaves = newNumSlaves;
                const badge = document.getElementById('slaveBadge');
                if (status.wkc_mismatch && connectedCount < totalSlaves) {
                    badge.textContent = `${connectedCount}/${totalSlaves} motors`;
                } else {
                    badge.textContent = numSlaves > 0 ? `${numSlaves} motor${numSlaves > 1 ? 's' : ''}` : '';
                }
                updatePillarLayout();
                tplUpdateSpeedTestSlaveOptions();
                updateTemplateMismatchUI();
            }

            const resetBtn = document.getElementById('resetErrorBtn');
            if (resetBtn) resetBtn.style.display = hasFault ? 'block' : 'none';
            updateErrorSolutionBox(!!(resetBtn && resetBtn.style.display !== 'none'));

            // Disable home/pattern buttons when fault active or slave is disconnected
            const btnHome = document.getElementById('btnSetHome');
            const btnPattern = document.getElementById('btnRunPattern');
            const btnSync = document.getElementById('syncMoveBtn');
            if (btnHome) btnHome.disabled = hasFault || slaveDisconnected;
            if (btnPattern) btnPattern.disabled = hasFault || slaveDisconnected;
            if (btnSync) btnSync.disabled = hasFault || slaveDisconnected;

            // On new real fault: navigate to main page (where reset button is)
            // Backend handles stopping the template - we do NOT send 'stop' from frontend.
            if (reconnectGrace > 0) {
                reconnectGrace--;
                hadFaultPrev = hasFault;
            } else if (hasFault && !hadFaultPrev) {
                console.warn('[FAULT] Real fault detected, navigating to main page. SW:', latestStatusWords.map(w => '0x' + w.toString(16)));
                // Update pattern state (backend already stopped it)
                isPatternRunning = false;
                updatePatternUI();
                debugStopStepTimer();
                navigateToMain();
            }
            hadFaultPrev = hasFault;

            // WKC mismatch: slave disconnected — catch any case not already handled by template_stop
            if (status.wkc_mismatch && !slaveDisconnected) {
                slaveDisconnected = true;
                wkcOkCount = 0;
                totalSlavesBeforeDisconnect = totalSlaves;
                if (isPatternRunning) {
                    sendCmd('stop');
                    setTimeout(() => sendCmd('osc_disconnect'), 200);
                    isPatternRunning = false;
                    updatePatternUI();
                    debugStopStepTimer();
                    saveStateCache();
                }
                sendCmd('disable');
                navigateToMain();
                const slaveLabel = status.first_disconnected_slave > 0
                    ? `Slave ${status.first_disconnected_slave}` : 'A slave';
                showDisconnectBanner('recovering', `${slaveLabel} disconnected — trying to reconnect...`);
                scheduleInterfaceOverlay('Slave disconnected - checking interfaces...');
            }

            // When WKC returns to normal after a disconnect, confirm reconnect over 3 polls (~150ms)
            // to avoid false positives from slave_change callback resetting the counter briefly
            if (slaveDisconnected) {
                if (!status.wkc_mismatch) {
                    wkcOkCount++;
                    if (wkcOkCount >= 3) {
                        wkcOkCount = 0;
                        slaveDisconnected = false;
                        reconnectGrace = 5;
                        hadFaultPrev = hasFault;
                        // Restore full slave count in badge
                        const restored = totalSlavesBeforeDisconnect || totalSlaves;
                        if (restored > numSlaves) {
                            numSlaves = restored;
                            lastNumSlaves = restored;
                            const badge = document.getElementById('slaveBadge');
                            if (badge) badge.textContent = `${restored} motor${restored > 1 ? 's' : ''}`;
                            updatePillarLayout();
                        }
                        if (hasFault) {
                            showDisconnectBanner('error', 'Slave reconnected but has an error — press Reset Error below');
                        } else {
                            showDisconnectBanner('ok', 'All good — slave reconnected successfully');
                            setTimeout(() => hideDisconnectBanner(), 5000);
                        }
                    }
                } else {
                    wkcOkCount = 0;
                }
            }

            // Interface selection: detect persistent disconnection (even if state isn't 0)
            const noSlavesConnected = (status.num_slaves || 0) === 0;
            const suppressInterfaceOverlay = isTemplateScreenActive();
            if (suppressInterfaceOverlay) {
                if (interfaceOverlayShown) hideInterfaceOverlay();
            } else if (forceInterfaceOverlay) {
                // Force the interface picker even if status still reports "connected"
                if (!interfaceOverlayShown) {
                    showInterfaceOverlay();
                }
            } else if (noSlavesConnected && (status.state === 0 || status.wkc_mismatch || slaveDisconnected)) {
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
            // Clear any pending interface overlay timer if we're connected
            if (systemState > 0 && (status.num_slaves || 0) > 0) {
                clearInterfaceOverlayTimer();
                forceInterfaceOverlay = false;
            }

            // Debug panel slave table update
            updateDebugSlaveTable(status);
        }

        function updateConnectionUI(state, moving) {
            const dot = document.getElementById('statusDot');
            const text = document.getElementById('statusText');

            dot.className = 'status-dot';
            if (hasFault) {
                dot.classList.add('fault');
                text.textContent = 'Something went wrong!';
                text.style.color = 'var(--red)';
            } else if (state === 0) {
                dot.classList.add('disconnected');
                text.textContent = 'Not connected';
                text.style.color = 'var(--text-light)';
            } else if (state === 1) {
                dot.classList.add('connected');
                text.textContent = 'Connected';
                text.style.color = 'var(--blue)';
            } else if (state === 2) {
                if (moving) {
                    dot.classList.add('moving');
                    text.textContent = 'Moving!';
                    text.style.color = 'var(--green)';
                } else {
                    dot.classList.add('enabled');
                    text.textContent = 'Ready';
                    text.style.color = 'var(--green)';
                }
            }
            if (hasFault) updateErrorSolutionBox(true);
        }

        function updateUdpStatus(status) {
            if (!status) return;
            if (status.udp_connected !== undefined) {
                udpConnected = !!status.udp_connected;
                updateUdpConnectButton();
            }
            const ipEl = document.getElementById('udpSyncIp');
            const portEl = document.getElementById('udpSyncPort');
            const canOverwrite = (udpConnected || status.udp_connected) && !udpFormTouched;
            if (ipEl && status.udp_ip && document.activeElement !== ipEl && canOverwrite) {
                ipEl.value = status.udp_ip;
            }
            if (portEl && status.udp_port && document.activeElement !== portEl && canOverwrite) {
                portEl.value = status.udp_port;
            }
            const modeEl = document.getElementById('udpModeInfo');
            if (modeEl) {
                const modeName = status.udp_mode === 1 ? 'Duration' : 'Position';
                modeEl.textContent = `Mode: ${modeName}`;
            }
            const modeSelect = document.getElementById('udpModeSelect');
            if (modeSelect && status.udp_mode !== undefined) {
                modeSelect.value = String(status.udp_mode);
            }
        }

        // ========================================================
        // Response Handler
        // ========================================================
        function handleResponse(resp) {
            // Handle reset/clear_error responses
            if (resetInProgress && handleResetResponse(resp)) return;

            if (resp.data && resp.data.config) {
                loadedConfig = resp.data.config;
                if (pendingLoadConfigFilename) {
                    loadedConfigFilename = pendingLoadConfigFilename;
                    pendingLoadConfigFilename = '';
                }
                const name = loadedConfig.template?.name || defaultTemplateName;
                const display = document.getElementById('templateNameDisplay');
                if (display) display.textContent = name || 'Unknown Template';

                // Debug: cache template steps and render table
                debugTemplateSteps = loadedConfig.template?.steps || [];
                debugResetStepTimings();
                updateDebugTemplateTable();
                saveStateCache();
                updateTemplateMismatchUI();
            }
            if (pendingRunPattern && loadedConfigFilename === defaultTemplateName) {
                pendingRunPattern = false;
                runPattern(true);
            }

            // Debug: handle template_start
            if (resp.data && resp.data.template_start) {
                debugResetStepTimings();
            }

            // Debug: handle template_step events
            if (resp.data && resp.data.template_step) {
                const step = resp.data.template_step;
                if (step.event === 'start') {
                    debugStartStep(step.index);
                    if (step.move_order && step.move_order.length > 0) {
                        debugUpdateMoveOrder(step.index, step.move_order, step.is_spreading);
                    }
                } else if (step.event === 'complete') {
                    debugCompleteStep(step.index, step.time_taken || 0, step.movement_time, step.delay);
                }
            }

            if (resp.data && resp.data.tpl_speed_test) {
                handleTplSpeedTestResult(resp);
            }

            if (resp.data && resp.data.template_complete) {
                // loop continues automatically
                debugStopStepTimer();
            }

            if (resp.data && resp.data.udp_log) {
                addUdpLog(resp.data.udp_log);
            }

            // Handle slave disabled during template run
            if (resp.data && resp.data.slave_disabled) {
                debugStopStepTimer();
                isPatternRunning = false;
                updatePatternUI();
                saveStateCache();
                sendCmd('disable');
                navigateToMain();
                showToast(`Slave ${resp.data.slave_disabled.slave_num} disabled — drives stopped`);
            }

            // ── Quick disconnect (fires ~55ms after disconnect — background monitoring) ──
            if (resp.data && resp.data.slave_disconnected) {
                const info = resp.data.slave_disconnected;
                if (!slaveDisconnected) {
                    slaveDisconnected = true;
                    wkcOkCount = 0;
                    debugStopStepTimer();
                    if (isPatternRunning) {
                        isPatternRunning = false;
                        updatePatternUI();
                        saveStateCache();
                        sendCmd('stop');
                    }
                    sendCmd('disable');
                    navigateToMain();

                    // Update badge to show only connected slaves
                    const connected = info.connected_slaves || 0;
                    const total = info.total_slaves || numSlaves;
                    totalSlavesBeforeDisconnect = total;
                    if (connected > 0 && connected < total) {
                        numSlaves = connected;
                        lastNumSlaves = connected;
                        const badge = document.getElementById('slaveBadge');
                        if (badge) badge.textContent = `${connected}/${total} motors`;
                        updatePillarLayout();
                    }

                    const slaveLabel = info.first_disconnected_slave > 0
                        ? `Slave ${info.first_disconnected_slave}` : 'A slave';
                    showDisconnectBanner('recovering', `${slaveLabel} disconnected — trying to reconnect...`);
                    scheduleInterfaceOverlay('Slave disconnected - checking interfaces...');
                }
            }

            // ── Quick reconnect (fires when WKC returns to full) ──
            if (resp.data && resp.data.slave_reconnected) {
                const info = resp.data.slave_reconnected;
                if (slaveDisconnected) {
                    slaveDisconnected = false;
                    wkcOkCount = 0;
                    reconnectGrace = 5;
                    hadFaultPrev = hasFault;

                    // Restore full slave count
                    const total = info.total_slaves || totalSlavesBeforeDisconnect || numSlaves;
                    numSlaves = total;
                    lastNumSlaves = total;
                    lastWkcMismatch = false;
                    const badge = document.getElementById('slaveBadge');
                    if (badge) badge.textContent = total > 0 ? `${total} motor${total > 1 ? 's' : ''}` : '';
                    updatePillarLayout();

                    if (hasFault) {
                        showDisconnectBanner('error', 'Slave reconnected but has an error — press Reset Error below');
                    } else {
                        showDisconnectBanner('ok', 'All good — slave reconnected successfully');
                        setTimeout(() => hideDisconnectBanner(), 5000);
                    }
                }
                clearInterfaceOverlayTimer();
            }

            // Handle communication error (fires ~200ms after disconnect, before slave_change)
            if (resp.data && resp.data.communication_error) {
                debugStopStepTimer();
                if (isPatternRunning) {
                    isPatternRunning = false;
                    updatePatternUI();
                    saveStateCache();
                }
                sendCmd('disable');
                navigateToMain();
                if (!slaveDisconnected) {
                    slaveDisconnected = true;
                    wkcOkCount = 0;
                    disconnectedSlaveNum = 0;
                    showDisconnectBanner('recovering', 'Slave disconnected — trying to reconnect...');
                }
                scheduleInterfaceOverlay('Communication error - checking interfaces...');
            }

            // Handle slave disconnect (fires ~1s after, after communication_error already handled it)
            if (resp.data && resp.data.slave_change) {
                debugStopStepTimer();
                if (isPatternRunning) {
                    isPatternRunning = false;
                    updatePatternUI();
                    saveStateCache();
                }
                sendCmd('disable');
                navigateToMain();
                // Update banner with WKC info if not already showing a specific slave
                if (!slaveDisconnected) {
                    slaveDisconnected = true;
                    wkcOkCount = 0;
                    disconnectedSlaveNum = 0;
                }
                showDisconnectBanner('recovering', 'Slave disconnected — trying to reconnect...');
                scheduleInterfaceOverlay('Slave disconnected - checking interfaces...');
            }

            // Handle template error/fault from backend
            if (resp.data && resp.data.template_error) {
                const error = resp.data.template_error;
                debugStopStepTimer();
                if (isPatternRunning) {
                    isPatternRunning = false;
                    updatePatternUI();
                    saveStateCache();
                }
                // Navigate to main so the Reset Error button is visible
                navigateToMain();
                showToast(error.reason || resp.message || 'Template error — check slave status');
            }

            // Handle recovery success (from reset that triggered reconnect)
            if (resp.data && resp.data.recovery_success !== undefined) {
                if (resp.data.recovery_success) {
                    // Recovery worked — let actual hasFault from next status poll decide banner
                    slaveDisconnected = false;
                    wkcOkCount = 0;
                    reconnectGrace = 5;       // Suppress false fault edge detection after reconnect
                    hadFaultPrev = hasFault;  // Prevent navigateToMain() from triggering on stale fault
                    forceInterfaceOverlay = false;
                    if (hasFault) {
                        showDisconnectBanner('error', 'Slave reconnected but has an error — press Reset Error below');
                    } else {
                        showDisconnectBanner('ok', 'Reconnected successfully — all good');
                        setTimeout(() => hideDisconnectBanner(), 5000);
                    }
                } else {
                    forceInterfaceOverlay = true;
                    showToast('Reset failed - try restarting the program.');
                    showInterfaceOverlay();
                }
                clearInterfaceOverlayTimer();
            }

            // Handle template stop
            if (resp.data && resp.data.template_stop) {
                debugStopStepTimer();
                const wasRunning = isPatternRunning;
                if (isPatternRunning) {
                    isPatternRunning = false;
                    updatePatternUI();
                    saveStateCache();
                }
                if (wasRunning) {
                    // Backend stopped the template (not user) — go to main, disable drives
                    sendCmd('disable');
                    navigateToMain();
                    slaveDisconnected = true;
                    wkcOkCount = 0;
                    showDisconnectBanner('recovering', 'Slave disconnected — checking status...');
                } else {
                    // User stopped — stay on pattern page
                    setPatternStatus('Template stopped.', 'stopped');
                }
            }

            if (resp.message && (resp.message.includes('STOP') || resp.message.includes('stopped'))) {
                if (isPatternRunning) {
                    isPatternRunning = false;
                    updatePatternUI();
                    saveStateCache();
                }
                debugStopStepTimer();
            }
        }

        function addUdpLog(entry) {
            if (!entry) return;
            udpLogEntries.push(entry);
            if (udpLogEntries.length > 60) udpLogEntries.shift();
            renderUdpLog();
        }

        function renderUdpLog() {
            const list = document.getElementById('udpLogList');
            if (!list) return;
            if (!udpLogEntries.length) {
                list.textContent = 'No UDP messages yet.';
                return;
            }
            let html = '';
            udpLogEntries.slice(-60).forEach(entry => {
                if (Array.isArray(entry.positions) && entry.positions.length > 0) {
                    entry.positions.forEach(p => {
                        if (p.duration !== undefined) {
                            const dir = (p.direction === 1) ? 'forward' : (p.direction === -1 ? 'backward' : 'halt');
                            const pos = (p.position !== undefined) ? Number(p.position).toFixed(3) : '';
                            const posText = pos ? `, position: ${pos}` : '';
                            html += `<div class="udp-log-item">slave: ${p.slave}, duration: ${p.duration}s, direction: ${dir}${posText}</div>`;
                        } else {
                            const pos = (p.position !== undefined) ? Number(p.position).toFixed(3) : '';
                            html += `<div class="udp-log-item">slave: ${p.slave}, position: ${pos}</div>`;
                        }
                    });
                } else {
                    html += `<div class="udp-log-item">${entry.message || 'UDP event'}</div>`;
                }
            });
            list.innerHTML = html;
        }

        // ========================================================
        // Page Navigation
        // ========================================================
        function navigateToMain() {
            if (currentPage === 'main') return;
            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            document.getElementById('page-main').classList.add('active');
            currentPage = 'main';
            updateDebugTemplateTable();
            saveStateCache();
        }

        function showDisconnectBanner(type, message) {
            const el = document.getElementById('disconnectBanner');
            if (!el) return;
            el.textContent = message;
            el.className = 'disconnect-banner ' + type;
            el.style.display = 'block';
        }

        function hideDisconnectBanner() {
            const el = document.getElementById('disconnectBanner');
            if (el) { el.style.display = 'none'; el.textContent = ''; }
        }

        function showPage(page) {
            // Disable drives when leaving home or pattern page back to main
            if (page === 'main' && (currentPage === 'home' || currentPage === 'pattern' || currentPage === 'sync')) {
                if (currentPage === 'sync') {
                    sendCmd('udp_disconnect');
                    udpConnected = false;
                    updateUdpConnectButton();
                }
                sendCmd('disable');
            }

            // Remove home page key listener when leaving
            if (currentPage === 'home' && page !== 'home') {
                document.removeEventListener('keydown', handleHomeKeyDown);
            }

            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            document.getElementById('page-' + page).classList.add('active');
            currentPage = page;

            if (page === 'home') enterHomePage();
            else if (page === 'pattern') enterPatternPage();
            else if (page === 'sync') enterSyncPage();
            if (page !== 'main') hideDisconnectBanner();

            updateDebugTemplateTable();
            saveStateCache();
        }

        // Restore page on reconnect without re-sending mode/enable commands
        async function restorePage(page, templateFilename) {
            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            document.getElementById('page-' + page).classList.add('active');
            currentPage = page;

            // Load UI data only (no mode/enable commands)
            if (page === 'pattern') {
                // Use provided filename from backend status, or fetch default
                let filename = templateFilename;
                if (!filename) {
                    await fetchDefaultTemplate();
                    filename = defaultTemplateName;
                } else {
                    defaultTemplateName = filename;
                    const display = document.getElementById('templateNameDisplay');
                    if (display) display.textContent = filename.replace('.json', '');
                }
                if (filename) {
                    sendCmd('load_config', { filename: filename });
                }
                loadOscConfig();
            }

            updateDebugTemplateTable();
        }

        // ========================================================
        // Set Home Positions Page
        // ========================================================
        function getHomeSpeed() {
            const speedMs = parseFloat(document.getElementById('velocitySpeed').value) || 1;
            const velocity = Math.round(speedMs * 1000);
            const accel = Math.round(velocity / 2);
            return { velocity, acceleration: accel, deceleration: accel };
        }

        function enterHomePage() {
            const sp = getHomeSpeed();
            sendCmd('set_mode', {
                mode: 3,
                speed: { velocity: sp.velocity, acceleration: sp.acceleration, deceleration: sp.deceleration, mode_type: 'PV' }
            });
            setTimeout(() => sendCmd('enable'), 300);
            // Space key -> Stop when on home page
            document.addEventListener('keydown', handleHomeKeyDown);
        }

        function handleHomeKeyDown(e) {
            if (e.code === 'Space' || e.key === ' ') {
                e.preventDefault();
                emergencyStop();
            }
        }

        function applyHomeSpeed() {
            enforceSpeedLimit();
            const sp = getHomeSpeed();
            sendCmd('set_speed', { velocity: sp.velocity, acceleration: sp.acceleration, deceleration: sp.deceleration });
        }

        function updateSpeedInputState() {
            const input = document.getElementById('velocitySpeed');
            input.disabled = (selectedPillar < 0);
        }

        function onSpeedLimitChange() {
            const input = document.getElementById('velocitySpeed');
            const limited = document.getElementById('speedLimitCheck').checked;
            if (limited) {
                input.max = 5;
                enforceSpeedLimit();
            } else {
                input.removeAttribute('max');
            }
        }

        function enforceSpeedLimit() {
            const input = document.getElementById('velocitySpeed');
            const limited = document.getElementById('speedLimitCheck').checked;
            if (limited && parseFloat(input.value) > 5) {
                input.value = 5;
            }
        }

        // ========================================================
        // Run Pattern Page
        // ========================================================
        async function enterPatternPage() {
            sendCmd('set_mode', {
                mode: 1,
                speed: { velocity: 80000, acceleration: 40000, deceleration: 40000, mode_type: 'PP' }
            });
            setTimeout(() => sendCmd('enable'), 300);

            await fetchDefaultTemplate();
            if (defaultTemplateName) {
                sendCmd('load_config', { filename: defaultTemplateName });
            }
            loadOscConfig();
        }

        // ========================================================
        // OSC Config
        // ========================================================
        function updateOscModeUI() {
            const mode = document.getElementById('oscMode').value;
            document.getElementById('oscSendFields').style.display = (mode === 'send' || mode === 'both') ? '' : 'none';
            document.getElementById('oscRecvFields').style.display = (mode === 'receive' || mode === 'both') ? '' : 'none';
        }

        async function loadOscConfig() {
            try {
                const resp = await fetch('/api/config');
                const cfg = await resp.json();
                const osc = cfg.osc || {};

                // Set mode
                const modeEl = document.getElementById('oscMode');
                if (osc.osc_mode && ['send', 'receive', 'both'].includes(osc.osc_mode)) {
                    modeEl.value = osc.osc_mode;
                }
                updateOscModeUI();

                // Set IPs and ports
                if (osc.send_ip) document.getElementById('oscSendIp').value = osc.send_ip;
                if (osc.send_port) document.getElementById('oscSendPort').value = osc.send_port;
                if (osc.recv_ip) document.getElementById('oscRecvIp').value = osc.recv_ip;
                if (osc.recv_port) document.getElementById('oscRecvPort').value = osc.recv_port;

                // Set address list
                if (osc.osc_send_address && Array.isArray(osc.osc_send_address)) {
                    oscSendAddresses = osc.osc_send_address;
                }
                renderOscAddressList();
                loadOscListenerConfig();
                updateOscReceiverButton();
            } catch (e) {}
        }

        async function saveOscConfig(mode, sendIp, sendPort, recvIp, recvPort, addresses) {
            try {
                const resp = await fetch('/api/config');
                const cfg = await resp.json();
                cfg.osc = {
                    osc_mode: mode,
                    send_ip: sendIp,
                    send_port: sendPort,
                    recv_ip: recvIp,
                    recv_port: recvPort,
                    osc_send_address: addresses
                };
                await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(cfg)
                });
            } catch (e) {
                console.warn('Failed to save OSC config:', e);
            }
        }

        function renderOscAddressList() {
            const container = document.getElementById('oscAddressList');
            if (!container || oscSendAddresses.length === 0) {
                if (container) container.innerHTML = '';
                return;
            }
            let html = '<div class="osc-addr-list"><div class="osc-addr-title">Send Addresses:</div>';
            for (const addr of oscSendAddresses) {
                html += `<div class="osc-addr-item">${addr}</div>`;
            }
            html += '</div>';
            container.innerHTML = html;
        }

        async function loadOscListenerConfig() {
            try {
                const resp = await fetch('/api/osc_listener');
                const cfg = await resp.json();
                const defaultCfg = {
                    receiver: { ip: '0.0.0.0', port: 7003 },
                    default_speed: { velocity: 80000, acceleration: 40000, deceleration: 40000 },
                    listeners: []
                };
                oscListenerConfig = { ...defaultCfg, ...(cfg || {}) };
                if (!oscListenerConfig.receiver) oscListenerConfig.receiver = defaultCfg.receiver;
                if (!Array.isArray(oscListenerConfig.listeners)) oscListenerConfig.listeners = [];
                return oscListenerConfig;
            } catch (e) {
                if (!oscListenerConfig) {
                    oscListenerConfig = {
                        receiver: { ip: '0.0.0.0', port: 7003 },
                        default_speed: { velocity: 80000, acceleration: 40000, deceleration: 40000 },
                        listeners: []
                    };
                }
                return oscListenerConfig;
            }
        }

        async function saveOscListenerConfig() {
            if (!oscListenerConfig) return;
            await fetch('/api/osc_listener', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(oscListenerConfig)
            });
        }

        function updateOscReceiverButton() {
            const btn = document.getElementById('oscReceiverBtn');
            if (!btn) return;
            btn.classList.toggle('active', oscReceiverEnabled);
            btn.textContent = oscReceiverEnabled ? 'Receiver: On' : 'Receiver: Off';
        }

        async function toggleOscReceiver() {
            if (oscReceiverEnabled) {
                sendCmd('osc_disconnect');
                oscReceiverEnabled = false;
                updateOscReceiverButton();
                return;
            }
            await loadOscListenerConfig();
            const recv = oscListenerConfig?.receiver || {};
            const recvIp = recv.ip || '0.0.0.0';
            const recvPort = parseInt(recv.port) || 8001;
            const sendIp = document.getElementById('oscSendIp').value || '127.0.0.1';
            const sendPort = parseInt(document.getElementById('oscSendPort').value) || 9000;
            sendCmd('osc_connect', {
                send_ip: sendIp,
                send_port: sendPort,
                recv_ip: recvIp,
                recv_port: recvPort,
                mode: 1,
                send_movement: false,
                send_template: false,
                send_clip_connect: false,
                osc_send_address: []
            });
            oscReceiverEnabled = true;
            updateOscReceiverButton();
        }

        async function openOscReceiverSettings() {
            await loadOscListenerConfig();
            const ipEl = document.getElementById('oscListenerIp');
            const portEl = document.getElementById('oscListenerPort');
            if (ipEl) ipEl.value = oscListenerConfig.receiver?.ip || '0.0.0.0';
            if (portEl) portEl.value = oscListenerConfig.receiver?.port || 7003;
            renderOscListenerList();
            fillOscSpeedDefaults();
            oscListenerActionChanged();
            const modal = document.getElementById('oscReceiverModal');
            if (modal) modal.classList.add('active');
        }

        function closeOscReceiverSettings(evt) {
            if (evt && evt.target && evt.target.id !== 'oscReceiverModal') return;
            const modal = document.getElementById('oscReceiverModal');
            if (modal) modal.classList.remove('active');
        }

        function toggleOscListenerForm() {
            const form = document.getElementById('oscListenerForm');
            if (!form) return;
            const next = (form.style.display === 'none' || !form.style.display) ? 'block' : 'none';
            form.style.display = next;
            if (next === 'block') {
                fillOscSpeedDefaults();
                oscListenerActionChanged();
            }
        }

        function toggleOscActionInfo(evt) {
            if (evt) evt.stopPropagation();
            const tip = document.getElementById('oscActionTooltip');
            if (!tip) return;
            const willShow = !tip.classList.contains('active');
            tip.classList.toggle('active');
            if (willShow) {
                setTimeout(() => {
                    document.addEventListener('click', hideOscActionTooltip, { once: true });
                }, 0);
            }
        }

        function hideOscActionTooltip() {
            const tip = document.getElementById('oscActionTooltip');
            if (tip) tip.classList.remove('active');
        }

        function fillOscSpeedDefaults() {
            const fallback = oscListenerConfig?.default_speed || {};
            const velEl = document.getElementById('oscListenerSpeedVel');
            const accEl = document.getElementById('oscListenerSpeedAcc');
            const decEl = document.getElementById('oscListenerSpeedDec');
            if (velEl && !velEl.value) velEl.value = fallback.velocity || 80000;
            if (accEl && !accEl.value) accEl.value = fallback.acceleration || 40000;
            if (decEl && !decEl.value) decEl.value = fallback.deceleration || 40000;
        }

        function oscListenerActionChanged() {
            const action = document.getElementById('oscListenerAction')?.value || 'start';
            const mappingRow = document.getElementById('oscListenerMappingRow');
            const mappingTypeEl = document.getElementById('oscListenerMappingType');
            const mappingCustom = document.getElementById('oscListenerMappingCustom');
            const posLabel = document.getElementById('oscMapPositionLabel');
            const posInput = document.getElementById('oscMapPosition');
            const hint = document.getElementById('oscMapHint');
            const slavesInput = document.getElementById('oscListenerSlaves');
            const slavesGroup = slavesInput ? slavesInput.closest('.input-group') : null;

            const supportsMapping = (action === 'start' || action === 'start_multi');
            if (mappingRow) mappingRow.style.display = supportsMapping ? 'block' : 'none';
            if (!supportsMapping && mappingTypeEl) mappingTypeEl.value = 'default';
            if (supportsMapping && action === 'start_multi' && mappingTypeEl && mappingTypeEl.value !== 'custom') {
                mappingTypeEl.value = 'custom';
            }
            if (mappingCustom) mappingCustom.style.display = (supportsMapping && mappingTypeEl?.value === 'custom') ? 'block' : 'none';
            if (slavesGroup) {
                const showSlaves = (action === 'start' || action === 'start_multi');
                slavesGroup.style.display = showSlaves ? 'block' : 'none';
            }

            if (action === 'start_multi') {
                if (posLabel) posLabel.textContent = 'Positions (m, comma)';
                if (posInput) posInput.placeholder = '0.5,1.0';
                if (hint) hint.textContent = 'Positions order should match the Slaves list.';
            } else {
                if (posLabel) posLabel.textContent = 'Position (m)';
                if (posInput) posInput.placeholder = '0.5';
                if (hint) hint.textContent = 'Add one mapping row at a time.';
            }

            if (oscListenerLastAction !== action) {
                clearOscMappingEntries();
                oscListenerLastAction = action;
            }
            oscListenerMappingChanged();
        }

        function oscListenerMappingChanged() {
            const type = document.getElementById('oscListenerMappingType')?.value || 'default';
            const custom = document.getElementById('oscListenerMappingCustom');
            const action = document.getElementById('oscListenerAction')?.value || 'start';
            const supportsMapping = (action === 'start' || action === 'start_multi');
            if (custom) custom.style.display = (supportsMapping && type === 'custom') ? 'block' : 'none';
            const speedMappingOpt = document.getElementById('oscListenerSpeedMappingOption');
            if (speedMappingOpt) {
                const show = (supportsMapping && type === 'custom');
                speedMappingOpt.style.display = show ? 'block' : 'none';
                speedMappingOpt.hidden = !show;
                speedMappingOpt.disabled = !show;
            }
            const speedTypeEl = document.getElementById('oscListenerSpeedType');
            if (speedTypeEl && (!supportsMapping || type !== 'custom') && speedTypeEl.value === 'mapping') {
                speedTypeEl.value = 'default';
            }
            oscListenerSpeedChanged();
            if (supportsMapping && type === 'custom') renderOscMappingList();
        }

        function oscListenerSpeedChanged() {
            const type = document.getElementById('oscListenerSpeedType')?.value || 'default';
            const speedBox = document.getElementById('oscListenerSpeedCustom');
            if (!speedBox) return;
            speedBox.style.display = (type === 'custom' || type === 'mapping') ? 'block' : 'none';
            if (type === 'custom' || type === 'mapping') fillOscSpeedDefaults();
        }

        function clearOscMappingEntries() {
            oscMappingEntries = [];
            renderOscMappingList();
        }

        function renderOscMappingList() {
            const list = document.getElementById('oscMappingList');
            if (!list) return;
            if (!oscMappingEntries.length) {
                list.innerHTML = '<div class="osc-empty">No mapping entries</div>';
                return;
            }
            let html = '<div class="osc-mapping-list">';
            oscMappingEntries.forEach((entry, idx) => {
                const posText = Array.isArray(entry.positions)
                    ? entry.positions.join(', ')
                    : entry.position;
                html += `<div class="osc-mapping-item">
                    <div>value ${entry.value} -> ${posText}</div>
                    <button class="osc-mapping-remove" onclick="removeOscMappingEntry(${idx})">Remove</button>
                </div>`;
            });
            html += '</div>';
            list.innerHTML = html;
        }

        function addOscMappingEntry() {
            const action = document.getElementById('oscListenerAction')?.value || 'start';
            if (action !== 'start' && action !== 'start_multi') return;
            const valueRaw = document.getElementById('oscMapValue')?.value;
            const posRaw = document.getElementById('oscMapPosition')?.value || '';
            const value = parseInt(valueRaw, 10);
            if (!Number.isFinite(value)) {
                showToast('Mapping value must be a number', 'error');
                return;
            }

            let entry = null;
            if (action === 'start') {
                const pos = parseFloat(posRaw);
                if (!Number.isFinite(pos)) {
                    showToast('Position must be a number', 'error');
                    return;
                }
                entry = { value, position: pos };
            } else {
                const positions = posRaw.split(',')
                    .map(p => parseFloat(p.trim()))
                    .filter(n => Number.isFinite(n));
                if (!positions.length) {
                    showToast('Positions must be comma-separated numbers', 'error');
                    return;
                }
                const slavesRaw = document.getElementById('oscListenerSlaves')?.value || '';
                const slaves = slavesRaw
                    .split(',')
                    .map(s => parseInt(s.trim(), 10))
                    .filter(n => Number.isFinite(n));
                if (slaves.length > 0 && positions.length !== slaves.length) {
                    showToast('Positions count must match Slaves count', 'error');
                    return;
                }
                entry = { value, positions };
            }

            const existing = oscMappingEntries.findIndex(e => e.value === value);
            if (existing >= 0) oscMappingEntries[existing] = entry;
            else oscMappingEntries.push(entry);
            renderOscMappingList();
            const valEl = document.getElementById('oscMapValue');
            const posEl = document.getElementById('oscMapPosition');
            if (valEl) valEl.value = '';
            if (posEl) posEl.value = '';
        }

        function removeOscMappingEntry(idx) {
            if (idx < 0 || idx >= oscMappingEntries.length) return;
            oscMappingEntries.splice(idx, 1);
            renderOscMappingList();
        }

        function renderOscListenerList() {
            const list = document.getElementById('oscListenerList');
            if (!list) return;
            const listeners = (oscListenerConfig && Array.isArray(oscListenerConfig.listeners))
                ? oscListenerConfig.listeners
                : [];
            if (listeners.length === 0) {
                list.innerHTML = '<div class="osc-empty">No active addresses</div>';
                return;
            }
            let html = '<div class="osc-listener-list">';
            listeners.forEach((l, idx) => {
                const addr = l.address || l.active_address || '';
                const action = l.action || 'start';
                let mapping = 'default';
                if (l.mapping) {
                    mapping = (typeof l.mapping === 'string') ? 'mapping-file' : 'custom';
                }
                let speed = 'default';
                if (l.speed) {
                    speed = (typeof l.speed === 'string') ? 'mapping-speed' : 'custom';
                }
                html += `<div class="osc-listener-item">
                    <div>
                        <div>${addr}</div>
                        <div class="osc-listener-meta">${action} | ${mapping} | ${speed}</div>
                    </div>
                    <button class="osc-listener-remove" onclick="removeOscListener(${idx})">Remove</button>
                </div>`;
            });
            html += '</div>';
            list.innerHTML = html;
        }

        async function saveOscReceiverSettings() {
            if (!oscListenerConfig) await loadOscListenerConfig();
            const ip = document.getElementById('oscListenerIp').value.trim() || '0.0.0.0';
            const port = parseInt(document.getElementById('oscListenerPort').value);
            oscListenerConfig.receiver = { ip, port: Number.isFinite(port) ? port : 7003 };
            await saveOscListenerConfig();
            showToast('Receiver settings saved');
            closeOscReceiverSettings();
        }

        async function addOscListener() {
            if (!oscListenerConfig) await loadOscListenerConfig();
            const address = document.getElementById('oscListenerAddress').value.trim();
            if (!address) {
                showToast('Address is required', 'error');
                return;
            }
            const action = document.getElementById('oscListenerAction').value;
            const supportsMapping = (action === 'start' || action === 'start_multi');
            const mappingType = supportsMapping
                ? document.getElementById('oscListenerMappingType').value
                : 'default';
            const speedType = document.getElementById('oscListenerSpeedType').value;
            const slavesRaw = document.getElementById('oscListenerSlaves').value.trim();
            const slaves = slavesRaw
                ? slavesRaw.split(',').map(s => parseInt(s.trim())).filter(n => Number.isFinite(n))
                : [];

            let mappingRef = '';
            let speedRef = '';
            let speedInline = null;

            if (supportsMapping && mappingType === 'custom') {
                if (!oscMappingEntries.length) {
                    showToast('Add at least one mapping entry', 'error');
                    return;
                }
                const mappingObj = {};
                if (action === 'start') {
                    oscMappingEntries.forEach(e => { mappingObj[e.value] = e.position; });
                } else {
                    oscMappingEntries.forEach(e => { mappingObj[e.value] = e.positions; });
                }

                let fileBase = (document.getElementById('oscListenerMappingFile').value || '').trim();
                if (!fileBase) fileBase = `mapping_${action}_${Date.now()}`;

                let speedObj = null;
                if (speedType === 'mapping' || speedType === 'custom') {
                    const vel = parseInt(document.getElementById('oscListenerSpeedVel').value);
                    const acc = parseInt(document.getElementById('oscListenerSpeedAcc').value);
                    const dec = parseInt(document.getElementById('oscListenerSpeedDec').value);
                    const fallback = oscListenerConfig.default_speed || {};
                    speedObj = {
                        velocity: Number.isFinite(vel) ? vel : (fallback.velocity || 80000),
                        acceleration: Number.isFinite(acc) ? acc : (fallback.acceleration || 40000),
                        deceleration: Number.isFinite(dec) ? dec : (fallback.deceleration || 40000)
                    };
                }

                const resp = await fetch('/api/osc_listener_mapping', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        filename: fileBase,
                        mapping: mappingObj,
                        speed: speedObj
                    })
                });
                const data = await resp.json();
                if (!data.success) {
                    showToast(data.error || 'Failed to save mapping', 'error');
                    return;
                }
                mappingRef = data.mapping_ref || '';
                if (speedType === 'mapping') speedRef = data.speed_ref || '';
                if (speedType === 'custom') speedInline = speedObj;
            } else if (supportsMapping && mappingType === 'default' && action === 'start_multi') {
                showToast('start_multi requires a custom mapping', 'error');
                return;
            } else if (speedType === 'custom') {
                const vel = parseInt(document.getElementById('oscListenerSpeedVel').value);
                const acc = parseInt(document.getElementById('oscListenerSpeedAcc').value);
                const dec = parseInt(document.getElementById('oscListenerSpeedDec').value);
                speedInline = {
                    velocity: Number.isFinite(vel) ? vel : 80000,
                    acceleration: Number.isFinite(acc) ? acc : 40000,
                    deceleration: Number.isFinite(dec) ? dec : 40000
                };
            }

            const entry = { address, action };
            if (mappingRef) entry.mapping = mappingRef;
            if (speedRef) entry.speed = speedRef;
            if (speedInline) entry.speed = speedInline;
            if (slaves.length > 0) entry.slaves = slaves;

            oscListenerConfig.listeners = oscListenerConfig.listeners || [];
            oscListenerConfig.listeners.push(entry);
            if (speedType === 'custom' && speedInline) {
                oscListenerConfig.default_speed = { ...speedInline };
            }
            await saveOscListenerConfig();
            renderOscListenerList();
            showToast('Active address added');
            clearOscMappingEntries();
            const mapFileEl = document.getElementById('oscListenerMappingFile');
            if (mapFileEl) mapFileEl.value = '';
            const form = document.getElementById('oscListenerForm');
            if (form) form.style.display = 'none';
        }

        async function removeOscListener(idx) {
            if (!oscListenerConfig || !Array.isArray(oscListenerConfig.listeners)) return;
            oscListenerConfig.listeners.splice(idx, 1);
            await saveOscListenerConfig();
            renderOscListenerList();
        }

        function leavePatternPage() {
            if (isPatternRunning) stopPattern();
            showPage('main');
        }

        async function fetchDefaultTemplate() {
            try {
                const resp = await fetch('/api/default_template');
                const data = await resp.json();
                defaultTemplateName = data.default_template || '';
                const display = document.getElementById('templateNameDisplay');
                if (display) {
                    display.textContent = defaultTemplateName
                        ? defaultTemplateName.replace('.json', '')
                        : 'No active template selected';
                }
                updateTemplateMismatchUI();
            } catch (e) {
                const display = document.getElementById('templateNameDisplay');
                if (display) display.textContent = 'Error loading template';
            }
        }

        async function loadTemplateSlaveCountCache() {
            if (templateSlaveCountCacheLoaded) return;
            try {
                const resp = await fetch('/api/configs');
                const data = await resp.json();
                const allFiles = (data.config_files || []).filter(f => f.filename !== 'config.json');
                templateSlaveCountCache = {};
                allFiles.forEach(f => {
                    templateSlaveCountCache[f.filename] = f.slave_count;
                });
                templateSlaveCountCacheLoaded = true;
            } catch (e) {
                // Ignore cache errors
            }
        }

        async function updateTemplateMismatchUI() {
            if (isPatternRunning) return false;
            const btn = document.getElementById('runPatternBtn');
            const name = defaultTemplateName || '';
            const connected = numSlaves || 0;
            let templateSlaveCount = (loadedConfigFilename && loadedConfigFilename === name)
                ? loadedConfig?.slaves?.count
                : null;

            if (!name) {
                if (btn) btn.disabled = true;
                const display = document.getElementById('templateNameDisplay');
                if (display) display.textContent = 'No active template selected';
                setPatternStatus('No active template selected. Set one in Template Editor.', 'stopped');
                return true;
            }

            if ((!templateSlaveCount || templateSlaveCount <= 0) && name) {
                await loadTemplateSlaveCountCache();
                if (!templateSlaveCountCache[name]) {
                    // Active template was deleted or missing
                    defaultTemplateName = '';
                    loadedConfig = null;
                    loadedConfigFilename = '';
                    const display = document.getElementById('templateNameDisplay');
                    if (display) display.textContent = 'No active template selected';
                    if (btn) btn.disabled = true;
                    setPatternStatus('No active template selected. Set one in Template Editor.', 'stopped');
                    return true;
                }
                templateSlaveCount = templateSlaveCountCache[name] || 0;
            }

            if (btn) {
                if (templateSlaveCount > 0 && connected > 0 && templateSlaveCount !== connected) {
                    btn.disabled = true;
                    const msgName = name ? name.replace('.json', '') : 'selected template';
                    setPatternStatus(`selected template ${msgName} has ${templateSlaveCount} slave${templateSlaveCount > 1 ? 's' : ''} but connected slaves are ${connected} thus select relevant template`, 'stopped');
                    return true;
                }
                btn.disabled = false;
            }
            setPatternStatus('', '');
            return false;
        }

        async function runPattern(skipLoadCheck = false) {
            if (await updateTemplateMismatchUI()) return;
            if (!loadedConfig) {
                if (defaultTemplateName) {
                    pendingRunPattern = true;
                    setPatternStatus('Loading selected template...', 'running');
                    sendCmd('load_config', { filename: defaultTemplateName });
                    return;
                }
                setPatternStatus('No active template selected. Set one in Template Editor.', 'stopped');
                return;
            }
            if (!skipLoadCheck && defaultTemplateName && loadedConfigFilename !== defaultTemplateName) {
                pendingRunPattern = true;
                setPatternStatus('Loading selected template...', 'running');
                sendCmd('load_config', { filename: defaultTemplateName });
                return;
            }

            const modeStr = document.getElementById('oscMode').value;
            const modeMap = { send: 2, receive: 1, both: 3 };
            const oscMode = modeMap[modeStr] || 2;
            const sendIp = document.getElementById('oscSendIp').value;
            const sendPort = parseInt(document.getElementById('oscSendPort').value);
            const recvIp = document.getElementById('oscRecvIp').value;
            const recvPort = parseInt(document.getElementById('oscRecvPort').value);

            // Save OSC config to config.json so it persists
            saveOscConfig(modeStr, sendIp, sendPort, recvIp, recvPort, oscSendAddresses);

            // Determine which addresses to send based on config list
            const addrList = oscSendAddresses;
            const sendTemplate = addrList.some(a => a.includes('template_step'));
            const sendClipConnect = addrList.some(a => a.includes('clips') && a.includes('connect'));
            const sendMovement = addrList.some(a => a.includes('movement'));

            sendCmd('osc_connect', {
                send_ip: sendIp,
                send_port: sendPort,
                recv_ip: recvIp,
                recv_port: recvPort,
                mode: oscMode,
                send_movement: sendMovement,
                send_template: sendTemplate,
                send_clip_connect: sendClipConnect,
                osc_send_address: addrList
            });

            setTimeout(() => {
                sendCmd('template_loop', { config: loadedConfig });
                isPatternRunning = true;
                updatePatternUI();
                setPatternStatus('Template running in loop...', 'running');
                saveStateCache();
            }, 500);
        }

        function stopPattern() {
            sendCmd('stop');
            setTimeout(() => sendCmd('osc_disconnect'), 200);
            isPatternRunning = false;
            updatePatternUI();
            setPatternStatus('Template stopped.', 'stopped');
            saveStateCache();
        }

        function updatePatternUI() {
            document.getElementById('runPatternBtn').disabled = isPatternRunning;
            document.getElementById('stopPatternBtn').disabled = !isPatternRunning;
            const syncBtn = document.getElementById('syncMoveBtn');
            if (syncBtn) syncBtn.disabled = isPatternRunning;
            // Disable Template Editor button while template is running
            document.getElementById('btnOpenTplEditor').disabled = isPatternRunning;
            // Disable OSC inputs while template is running
            document.querySelectorAll('#oscConfigCard input, #oscConfigCard select, #oscConfigCard button').forEach(el => el.disabled = isPatternRunning);
            if (!isPatternRunning) updateTemplateMismatchUI();
        }

        function openSyncMovement() {
            showPage('sync');
        }

        function enterSyncPage() {
            bindUdpInputs();
            loadUdpConfig(true);
            sendCmd('set_mode', {
                mode: 8,
                speed: { mode_type: 'CSP', csp_velocity: 800 }
            });
            setTimeout(() => sendCmd('enable'), 300);
            showToast('CSP mode enabled');
            updateUdpConnectButton();
        }

        function leaveSyncPage() {
            showPage('main');
        }

        function updateUdpConnectButton() {
            const btn = document.getElementById('udpConnectBtn');
            if (!btn) return;
            btn.classList.toggle('active', udpConnected);
            btn.textContent = udpConnected ? 'Disconnect' : 'Connect';
        }

        function bindUdpInputs() {
            if (udpInputsBound) return;
            const ipEl = document.getElementById('udpSyncIp');
            const portEl = document.getElementById('udpSyncPort');
            const modeEl = document.getElementById('udpModeSelect');
            const speedEl = document.getElementById('udpCspMaxStep');
            if (ipEl) ipEl.addEventListener('input', () => { udpFormTouched = true; });
            if (portEl) portEl.addEventListener('input', () => { udpFormTouched = true; });
            if (modeEl) modeEl.addEventListener('change', () => { udpFormTouched = true; });
            if (speedEl) speedEl.addEventListener('input', () => { udpFormTouched = true; });
            udpInputsBound = true;
        }

        async function loadUdpConfig(forceFill = false) {
            try {
                const resp = await fetch('/api/config');
                const cfg = await resp.json();
                const udp = cfg.udp || {};
                const ipEl = document.getElementById('udpSyncIp');
                const portEl = document.getElementById('udpSyncPort');
                const modeEl = document.getElementById('udpModeSelect');
                const speedEl = document.getElementById('udpCspMaxStep');
                if ((forceFill || !udpFormTouched) && ipEl && udp.ip) ipEl.value = udp.ip;
                if ((forceFill || !udpFormTouched) && portEl && udp.port) portEl.value = udp.port;
                if (modeEl && udp.mode !== undefined) modeEl.value = String(udp.mode);
                if (speedEl && udp.max_step) speedEl.value = udp.max_step;
                if (modeEl) updateUdpModeLabel(parseInt(modeEl.value, 10) || 0);
            } catch (e) {}
        }

        async function saveUdpConfig(ip, port, mode, maxStep) {
            try {
                const resp = await fetch('/api/config');
                const cfg = await resp.json();
                cfg.udp = {
                    ip,
                    port,
                    mode,
                    max_step: maxStep
                };
                await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(cfg)
                });
            } catch (e) {
                console.warn('Failed to save UDP config:', e);
            }
        }

        function udpModeChanged() {
            const modeEl = document.getElementById('udpModeSelect');
            const mode = parseInt(modeEl?.value, 10) || 0;
            updateUdpModeLabel(mode);
            sendCmd('set_udp_mode', { mode });
            if (udpConnected) {
                showToast(`UDP mode set to ${mode === 1 ? 'Duration' : 'Position'}`);
            }
        }

        function updateUdpModeLabel(mode) {
            const modeEl = document.getElementById('udpModeInfo');
            if (modeEl) modeEl.textContent = `Mode: ${mode === 1 ? 'Duration' : 'Position'}`;
        }

        function udpSpeedChanged() {
            const speedEl = document.getElementById('udpCspMaxStep');
            const maxStep = parseInt(speedEl?.value, 10);
            if (udpConnected && Number.isFinite(maxStep)) {
                sendCmd('set_csp_max_step', { max_step: maxStep });
            }
        }

        function toggleUdpConnection() {
            const ip = document.getElementById('udpSyncIp')?.value?.trim() || '127.0.0.1';
            const portRaw = document.getElementById('udpSyncPort')?.value;
            const port = parseInt(portRaw, 10) || 9000;
            if (udpConnected) {
                sendCmd('udp_disconnect');
                udpConnected = false;
                updateUdpConnectButton();
                return;
            }
            const modeEl = document.getElementById('udpModeSelect');
            const mode = parseInt(modeEl?.value, 10) || 0;
            const speedEl = document.getElementById('udpCspMaxStep');
            const maxStep = parseInt(speedEl?.value, 10) || 800;
            sendCmd('set_udp_mode', { mode });
            sendCmd('set_csp_max_step', { max_step: maxStep });
            sendCmd('udp_connect', { ip, port });
            saveUdpConfig(ip, port, mode, maxStep);
            udpFormTouched = false;
            udpConnected = true;
            updateUdpConnectButton();
        }

        function setPatternStatus(text, type) {
            const el = document.getElementById('patternStatus');
            el.textContent = text;
            el.className = 'pattern-status ' + (type || '');
        }


        // ========================================================
        // Reset Error - Smart per-slave error handling
        // ========================================================
        const ER153_CODE = 0x7325;  // Multiturn encoder error - needs special handling
        let resetInProgress = false;
        let resetPendingCount = 0;
        let resetResults = [];      // { slave, success, message }

        async function resetError() {
            if (resetInProgress) return;

            // Identify faulted slaves and their error codes
            const faultedSlaves = [];
            for (let i = 0; i < latestStatusWords.length; i++) {
                const sw = latestStatusWords[i] || 0;
                if ((sw & 0x0008) || (sw === 0 && systemState >= 1)) {
                    faultedSlaves.push({
                        index: i,
                        errorCode: latestErrorCodes[i] || 0,
                        errorName: getErrorDisplay(latestErrorCodes[i] || 0)
                    });
                }
            }

            if (faultedSlaves.length === 0) {
                showToast('No faults detected');
                return;
            }

            // Separate Er153 slaves (need special SDO procedure) from others
            const er153Slaves = faultedSlaves.filter(s => s.errorCode === ER153_CODE);
            const otherSlaves = faultedSlaves.filter(s => s.errorCode !== ER153_CODE);

            const btn = document.getElementById('resetErrorBtn');
            if (btn) {
                btn.disabled = true;
                btn.querySelector('.emoji-icon').textContent = '\u23F3';  // hourglass
            }

            resetInProgress = true;
            resetResults = [];
            // Expected responses: 1 clear_error per Er153 slave + 1 bulk reset at the end
            resetPendingCount = er153Slaves.length + 1;

            showToast(`Resetting ${faultedSlaves.length} slave(s)...`);

            // Phase 1: Handle Er153 slaves first (special Pr0.15 SDO procedure, takes ~4s each)
            for (const slave of er153Slaves) {
                console.log(`[Reset] Phase 1 - Slave #${slave.index}: ${slave.errorName} (Er153 special handling)`);
                sendCmd('clear_error', { slave: slave.index });
                // Delay between commands so backend processes sequentially
                await new Promise(r => setTimeout(r, 100));
            }

            // Phase 2: Bulk reset handles everything else (Er81b, Er102, etc.)
            // - For Er81b/communication errors: reset_all + reconnect recovery
            // - For already-cleared Er153 slaves: harmless re-check
            // - For standard drive faults: controlword 0x80 reset
            if (er153Slaves.length > 0) {
                // Wait for Er153 clear_error responses before sending reset
                // Er153 takes ~4s per slave; wait enough time then send reset
                const waitMs = er153Slaves.length * 5000 + 500;
                console.log(`[Reset] Phase 2 - Waiting ${waitMs}ms for Er153 handling, then sending bulk reset`);
                setTimeout(() => sendCmd('reset'), waitMs);
            } else {
                console.log(`[Reset] No Er153 - sending bulk reset directly`);
                sendCmd('reset');
            }

            // Safety timeout: clean up if responses never arrive
            const totalTimeout = (er153Slaves.length * 6000) + 10000;
            setTimeout(() => {
                if (resetInProgress) {
                    resetInProgress = false;
                    resetPendingCount = 0;
                    const btn = document.getElementById('resetErrorBtn');
                    if (btn) {
                        btn.disabled = false;
                        btn.querySelector('.emoji-icon').textContent = '\uD83D\uDD27';
                    }
                    showToast('Reset timed out. Try again or power cycle drives.');
                }
            }, totalTimeout);
        }

        function handleResetResponse(resp) {
            if (!resetInProgress) return false;

            resetResults.push({
                success: resp.success,
                message: resp.message || ''
            });
            resetPendingCount--;

            if (resetPendingCount <= 0) {
                // All responses received
                resetInProgress = false;
                const btn = document.getElementById('resetErrorBtn');
                if (btn) {
                    btn.disabled = false;
                    btn.querySelector('.emoji-icon').textContent = '\uD83D\uDD27';  // wrench
                }

                const allSuccess = resetResults.every(r => r.success);
                const homingNeeded = resetResults.some(r => r.message && r.message.includes('HOMING'));
                const anyFailed = resetResults.some(r => !r.success);

                if (allSuccess && homingNeeded) {
                    hideDisconnectBanner();
                    showToast('Error cleared! Homing required before operation.');
                } else if (allSuccess) {
                    hasFault = false;
                    hadFaultPrev = false;
                    hideDisconnectBanner();
                    showToast('All faults cleared successfully.');
                } else if (anyFailed) {
                    const failMsgs = resetResults.filter(r => !r.success).map(r => r.message);
                    showToast(failMsgs[0] || 'Some errors could not be cleared. Try power cycling.');
                }
            }
            return true;
        }

        // ========================================================
        // Debug Panel
        // ========================================================
        function toggleDebugPanel() {
            debugPanelOpen = !debugPanelOpen;
            const panel = document.getElementById('debugPanel');
            const btn = document.getElementById('debugToggleBtn');
            if (debugPanelOpen) {
                panel.classList.add('show');
                btn.classList.add('active');
            } else {
                panel.classList.remove('show');
                btn.classList.remove('active');
            }
        }

        const ERROR_MAP = {
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
        function getErrorDisplay(errCode) {
            return ERROR_MAP[errCode] || ('Er' + errCode.toString(16).toUpperCase());
        }

        let errorSolutionMap = null;
        let errorSolutionLoaded = false;

        async function loadErrorSolutions() {
            if (errorSolutionLoaded) return;
            try {
                const resp = await fetch('/api/errorlist');
                const data = await resp.json();
                errorSolutionMap = {};
                if (Array.isArray(data)) {
                    data.forEach(item => {
                        if (!item || !item.hex_code) return;
                        const key = String(item.hex_code).toUpperCase();
                        errorSolutionMap[key] = item;
                    });
                }
                errorSolutionLoaded = true;
            } catch (e) {
                errorSolutionMap = {};
                errorSolutionLoaded = true;
            }
        }

        function formatHexCode(code) {
            const c = Number(code) || 0;
            return '0x' + c.toString(16).toUpperCase().padStart(4, '0');
        }

        function getPrimaryFaultCode() {
            for (let i = 0; i < latestStatusWords.length; i++) {
                const sw = latestStatusWords[i] || 0;
                if ((sw & 0x0008) || (sw === 0 && systemState >= 1)) {
                    const code = latestErrorCodes[i] || 0;
                    if (code) return code;
                }
            }
            const any = Array.isArray(latestErrorCodes) ? latestErrorCodes.find(c => (Number(c) || 0) !== 0) : 0;
            return any || latestErrorCodes[0] || 0;
        }

        async function updateErrorSolutionBox(forceShow = false) {
            const box = document.getElementById('errorSolutionBox');
            if (!box) return;
            const hasAnyCode = Array.isArray(latestErrorCodes) && latestErrorCodes.some(c => (Number(c) || 0) !== 0);
            if (!forceShow && !hasFault && !hasAnyCode) {
                box.hidden = true;
                box.style.display = 'none';
                return;
            }

            // Ensure visible immediately
            box.hidden = false;
            box.style.display = 'block';

            await loadErrorSolutions();
            const code = getPrimaryFaultCode();
            const hex = formatHexCode(code);
            const entry = (errorSolutionMap && errorSolutionMap[hex.toUpperCase()]) ? errorSolutionMap[hex.toUpperCase()] : null;

            const header = document.getElementById('errorSolutionHeader');
            const title = document.getElementById('errorSolutionTitle');
            const causeEl = document.getElementById('errorSolutionCause');
            const listEl = document.getElementById('errorSolutionList');
            if (!header || !title || !causeEl || !listEl) return;

            const errCode = entry && entry.error_code ? entry.error_code : getErrorDisplay(code);
            header.textContent = `${hex} · ${errCode}`;
            title.textContent = entry && entry.title ? entry.title : 'Unknown error';

            const causes = entry && Array.isArray(entry.cause) ? entry.cause : [];
            if (causes.length > 0) {
                const paragraph = causes.map(c => c.trim().replace(/\.$/, '')).join('. ') + '.';
                causeEl.textContent = paragraph;
            } else {
                causeEl.textContent = 'No detailed cause available for this error.';
            }

            const checks = entry && Array.isArray(entry.check) ? entry.check : [];
            listEl.innerHTML = '';
            if (checks.length > 0) {
                checks.forEach(item => {
                    const li = document.createElement('li');
                    li.textContent = item;
                    listEl.appendChild(li);
                });
            } else {
                ['Press Reset Error', 'If it persists, power cycle the drive', 'Inspect wiring and connections'].forEach(item => {
                    const li = document.createElement('li');
                    li.textContent = item;
                    listEl.appendChild(li);
                });
            }

            box.hidden = false;
            box.style.display = 'block';
            box.style.visibility = 'visible';
            box.style.opacity = '1';
        }

        function updateDebugSlaveTable(status) {
            if (!debugPanelOpen) return;
            const tbody = document.getElementById('debugSlaveTableBody');
            if (!tbody) return;

            const positions = status.positions || [];
            const statusWords = status.status_words || [];
            const errorCodes = status.error_codes || [];
            const globalState = status.state || 0;

            if (positions.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3" class="debug-empty">No motors connected</td></tr>';
                return;
            }

            // Rebuild rows if slave count changed
            if (!document.getElementById('dbg-pos-0') || tbody.children.length !== positions.length) {
                let html = '';
                for (let i = 0; i < positions.length; i++) {
                    html += `<tr>
                        <td style="font-weight:800; color:var(--text-light);">#${i}</td>
                        <td id="dbg-pos-${i}" style="font-variant-numeric:tabular-nums;"></td>
                        <td id="dbg-sw-${i}"></td>
                    </tr>`;
                }
                tbody.innerHTML = html;
            }

            // Update values
            for (let i = 0; i < positions.length; i++) {
                const pos = positions[i].toFixed(4);
                const sw = statusWords[i] || 0;
                const errCode = errorCodes[i] || 0;
                const enabled = (sw & 0x006F) === 0x0027;
                const fault = (sw & 0x0008) !== 0;

                const posEl = document.getElementById(`dbg-pos-${i}`);
                if (posEl && posEl.textContent !== pos) posEl.textContent = pos;

                const swEl = document.getElementById(`dbg-sw-${i}`);
                if (swEl) {
                    let dotClass = 'off', statusText = 'Off';
                    if (fault) {
                        dotClass = 'fault';
                        statusText = errCode ? getErrorDisplay(errCode) : 'Fault';
                    }
                    else if (enabled) { dotClass = 'ok'; statusText = 'Enabled'; }
                    else if (globalState >= 1) { dotClass = 'disabled'; statusText = 'Disabled'; }
                    const stateKey = dotClass + '-' + statusText;
                    if (swEl.dataset.state !== stateKey) {
                        swEl.dataset.state = stateKey;
                        swEl.innerHTML = `<span class="debug-status-dot ${dotClass}"></span>${statusText}`;
                    }
                }
            }
        }

        function updateDebugTemplateTable() {
            const section = document.getElementById('debugTemplateSection');
            const tbody = document.getElementById('debugTemplateTableBody');
            if (!section || !tbody) return;

            const showTemplate = (currentPage === 'pattern') && debugTemplateSteps.length > 0;
            section.style.display = showTemplate ? 'block' : 'none';
            if (!showTemplate) return;

            let html = '';
            debugTemplateSteps.forEach((step, i) => {
                const stepIndex = i + 1;
                const timing = debugStepTimings[stepIndex];
                let timeDisplay = '---';
                let timeClass = '';
                if (timing && timing.elapsed !== undefined) {
                    timeDisplay = timing.elapsed.toFixed(1) + 's';
                    timeClass = timing.final ? 'done' : 'running';
                }
                html += `<tr id="dbg-step-row-${stepIndex}">
                    <td style="font-weight:800; color:var(--text-light);">${stepIndex}</td>
                    <td>${step.name || 'Step ' + stepIndex}</td>
                    <td id="dbg-step-order-${stepIndex}" style="color:var(--text-light);">---</td>
                    <td class="debug-step-time ${timeClass}" id="dbg-step-time-${stepIndex}">${timeDisplay}</td>
                </tr>`;
            });
            tbody.innerHTML = html;

            // Re-apply active highlight
            if (debugCurrentStepIndex) {
                const activeRow = document.getElementById(`dbg-step-row-${debugCurrentStepIndex}`);
                if (activeRow) activeRow.classList.add('debug-step-active');
            }
        }

        function debugStartStep(stepIndex) {
            debugStopStepTimer();
            debugCurrentStepIndex = stepIndex;
            debugStepTimings[stepIndex] = { startTime: Date.now(), elapsed: 0, final: false };

            document.querySelectorAll('.debug-step-active').forEach(r => r.classList.remove('debug-step-active'));
            const row = document.getElementById(`dbg-step-row-${stepIndex}`);
            if (row) row.classList.add('debug-step-active');

            const timeCell = document.getElementById(`dbg-step-time-${stepIndex}`);
            if (timeCell) { timeCell.className = 'debug-step-time running'; timeCell.textContent = '0.0s'; }

            debugStepTimerInterval = setInterval(() => {
                if (debugStepTimings[stepIndex]) {
                    const elapsed = (Date.now() - debugStepTimings[stepIndex].startTime) / 1000;
                    debugStepTimings[stepIndex].elapsed = elapsed;
                    const cell = document.getElementById(`dbg-step-time-${stepIndex}`);
                    if (cell) cell.textContent = elapsed.toFixed(1) + 's';
                }
            }, 100);
        }

        function debugCompleteStep(stepIndex, totalTime, movementTime, delay) {
            debugStopStepTimer();
            debugStepTimings[stepIndex] = { elapsed: totalTime, final: true };

            const timeCell = document.getElementById(`dbg-step-time-${stepIndex}`);
            if (timeCell) {
                timeCell.className = 'debug-step-time done';
                if (movementTime !== undefined && delay !== undefined) {
                    const mt = movementTime.toFixed(1);
                    const dl = parseFloat(delay).toFixed(1);
                    timeCell.textContent = `${totalTime.toFixed(1)}s (${mt}+${dl})`;
                    timeCell.title = `Total: ${totalTime.toFixed(1)}s | Movement: ${mt}s | Delay: ${dl}s`;
                } else {
                    timeCell.textContent = totalTime.toFixed(1) + 's';
                }
            }

            const row = document.getElementById(`dbg-step-row-${stepIndex}`);
            if (row) { row.classList.remove('debug-step-active'); row.classList.add('debug-step-complete'); }
            debugCurrentStepIndex = null;
        }

        function debugStopStepTimer() {
            if (debugStepTimerInterval) { clearInterval(debugStepTimerInterval); debugStepTimerInterval = null; }
        }

        function debugUpdateMoveOrder(stepIndex, moveOrder, isSpreading) {
            const cell = document.getElementById(`dbg-step-order-${stepIndex}`);
            if (!cell) return;
            if (!moveOrder || moveOrder.length === 0) {
                cell.textContent = '---';
                cell.style.color = 'var(--text-light)';
                return;
            }
            const orderStr = moveOrder.map(s => s + 1).join('\u2192');
            cell.innerHTML = `<span style="color:var(--blue);">${isSpreading ? '\u2194' : '\u2192'}</span> ${orderStr}`;
            cell.style.color = 'var(--text)';
        }

        function debugResetStepTimings() {
            debugStopStepTimer();
            debugStepTimings = {};
            debugCurrentStepIndex = null;
            updateDebugTemplateTable();
        }

        // ========================================================
        // Interface Selection Overlay
        // ========================================================
        function isTemplateScreenActive() {
            const create = document.getElementById('tplCreateSection');
            const stepOverlay = document.getElementById('tplStepOverlay');
            const overlayCreate = document.getElementById('tplCreateOverlay');
            const overlayStep = document.getElementById('overlayTplStepOverlay');
            const createVisible = create && create.style.display !== 'none';
            const stepVisible = stepOverlay && stepOverlay.classList.contains('active');
            const overlayCreateVisible = overlayCreate && overlayCreate.style.display === 'flex';
            const overlayStepVisible = overlayStep && overlayStep.style.display === 'flex';
            return !!(createVisible || stepVisible || overlayCreateVisible || overlayStepVisible);
        }

        function scheduleInterfaceOverlay(reason) {
            if (interfaceOverlayTimer) return;
            interfaceOverlayTimer = setTimeout(() => {
                interfaceOverlayTimer = null;
                const noSlaves = (numSlaves || 0) === 0;
                const shouldShow = noSlaves || systemState === 0 || slaveDisconnected;
                if (!interfaceOverlayShown && shouldShow && !isTemplateScreenActive()) {
                    showInterfaceOverlay();
                    if (reason) showToast(reason, 'error');
                }
            }, 5000);
        }

        function clearInterfaceOverlayTimer() {
            if (interfaceOverlayTimer) {
                clearTimeout(interfaceOverlayTimer);
                interfaceOverlayTimer = null;
            }
        }

        function showInterfaceOverlay() {
            if (isTemplateScreenActive()) {
                interfaceOverlayShown = false;
                return;
            }
            interfaceOverlayShown = true;
            document.getElementById('interfaceOverlay').classList.add('show');
            scanInterfaces();
            loadOverlayTemplateList();
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
                    listContainer.innerHTML = '<div style="text-align:center; color:var(--text-light); padding:20px; font-weight:600;">No network adapters found.</div>';
                } else {
                    interfaces.sort((a, b) => b.slave_count - a.slave_count);

                    let html = '';
                    interfaces.forEach(iface => {
                        const hasSlaves = iface.slave_count > 0;
                        let rowClasses = 'interface-row';
                        if (hasSlaves) rowClasses += ' has-slaves';

                        const escapedName = iface.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                        const onclick = hasSlaves ? `onclick="selectInterface('${escapedName}')"` : '';

                        html += `<div class="${rowClasses}" ${onclick}>
                            <div class="iface-info">
                                <div class="iface-desc">${iface.desc}</div>
                                <div class="iface-name">${iface.name}</div>
                            </div>
                            <div class="iface-badge">
                                <span class="slave-count-badge ${hasSlaves ? 'has-slaves' : 'no-slaves'}">
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
                listContainer.innerHTML = `<div style="text-align:center; color:var(--red); padding:20px; font-weight:600;">Failed to scan: ${e.message}</div>`;
            }
        }

        async function selectInterface(interfaceName) {
            const statusMsg = document.getElementById('interfaceStatusMsg');

            statusMsg.className = 'interface-status-msg saving';
            statusMsg.textContent = 'Saving interface configuration...';

            try {
                const configResponse = await fetch('/api/config');
                const config = await configResponse.json();

                if (!config.config) config.config = {};
                config.config.network_interface = interfaceName;

                await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config)
                });

                statusMsg.textContent = 'Restarting motor process...';

                const restartResponse = await fetch('/api/restart_motor', { method: 'POST' });
                const restartResult = await restartResponse.json();

                if (restartResult.success) {
                    statusMsg.className = 'interface-status-msg success';
                    statusMsg.textContent = `Connected! ${restartResult.message}`;
                    disconnectedCounter = 0;
                    showPage('main');
                    setTimeout(() => hideInterfaceOverlay(), 1500);
                } else {
                    statusMsg.className = 'interface-status-msg error';
                    statusMsg.textContent = `Connection failed: ${restartResult.message}`;
                }

            } catch (e) {
                statusMsg.className = 'interface-status-msg error';
                statusMsg.textContent = `Error: ${e.message}`;
            }
        }

        // ========================================================
        // Template Editor
        // ========================================================
        let tplEditorOpen = false;
        let tplEditorMode = 'main'; // 'main' | 'overlay'
        let tplStepReturnTarget = 'create'; // 'create' | 'list'

        function setTplEditorMode(mode, stepReturnTarget) {
            tplEditorMode = mode || 'main';
            if (stepReturnTarget) tplStepReturnTarget = stepReturnTarget;
            const isOverlay = tplEditorMode === 'overlay';
            const cfgBtn = document.getElementById('tplConfigBtn');
            if (cfgBtn) cfgBtn.style.display = isOverlay ? 'none' : '';
            const panel = document.getElementById('tplSpeedTestPanel');
            if (isOverlay && panel) panel.style.display = 'none';
        }
        let tplEditingFile = null;

        // Step builder state
        let tplSetup = {};          // track/pillar config from form
        let tplSteps = [];          // [{positions: [..], delay: 2, slaveDelayMs: 30}, ...]
        let tplActiveStep = -1;     // which step is being edited (-1 = none)
        let tplDragPillar = -1;     // which pillar/slave is being dragged (index into positions[])
        let tplDragStartX = 0;
        let tplDragRect = null;     // cached pillarRect data for current drag
        let tplDragCircle = -1;     // which rotation circle is being dragged (HMRS)
        let tplDragCircleStartAngle = 0; // mouse angle at drag start
        let tplDragCircleStartVal = 0;   // rotation value at drag start
        let tplPillarPositions = []; // current positions on canvas for active step (meters)
        let tplSelectedPillars = []; // multi-select for matrix
        let tplPendingOrderPick = null;
        let tplPendingOrderMoved = false;
        let tplPendingSelectToggle = null;
        let tplPendingSelectMoved = false;
        let tplHomeStepDelay = 2;
        let tplZoom = 1;

        function openTemplateEditor(fromOverlay) {
            if (!fromOverlay) setTplEditorMode('main', 'create');
            document.querySelector('.template-info').style.display = 'none';
            document.querySelector('.pattern-grid').style.display = 'none';
            document.getElementById('patternStatus').style.display = 'none';
            document.getElementById('btnOpenTplEditor').style.display = 'none';
            document.getElementById('tplEditorList').style.display = '';
            document.getElementById('tplCreateSection').style.display = 'none';
            tplEditorOpen = true;
            loadTemplateList();
        }

        function closeTemplateEditor() {
            document.querySelector('.template-info').style.display = '';
            document.querySelector('.pattern-grid').style.display = '';
            document.getElementById('patternStatus').style.display = '';
            document.getElementById('btnOpenTplEditor').style.display = '';
            document.getElementById('tplEditorList').style.display = 'none';
            document.getElementById('tplCreateSection').style.display = 'none';
            tplEditorOpen = false;
        }

        async function loadTemplateList() {
            const body = document.getElementById('tplListBody');
            body.innerHTML = '<div style="color:var(--text-light);text-align:center;padding:20px;">Loading...</div>';
            try {
                const [configsResp, defaultResp] = await Promise.all([
                    fetch('/api/configs'),
                    fetch('/api/default_template')
                ]);
                const data = await configsResp.json();
                const defaultData = await defaultResp.json();
                const currentDefault = defaultData.default_template || '';

                const allFiles = (data.config_files || []).filter(f => f.filename !== 'config.json');
                templateSlaveCountCache = {};
                allFiles.forEach(f => { templateSlaveCountCache[f.filename] = f.slave_count; });
                templateSlaveCountCacheLoaded = true;
                // Only show templates matching connected slave count (0 = show all)
                const files = numSlaves > 0
                    ? allFiles.filter(f => f.slave_count === numSlaves)
                    : allFiles;

                if (files.length === 0) {
                    const extra = numSlaves > 0
                        ? ` matching ${numSlaves} connected slave${numSlaves > 1 ? 's' : ''}`
                        : '';
                    body.innerHTML = `<div style="color:var(--text-light);text-align:center;padding:20px;">No templates found${extra}. Create one!</div>`;
                    return;
                }
                body.innerHTML = files.map(f => {
                    const isActive = f.filename === currentDefault;
                    return `<div class="tpl-list-item">
                        <span class="tpl-item-name" style="flex:1;">
                            ${f.filename.replace('.json', '')}
                            ${isActive ? '<span style="color:var(--green);font-size:0.75rem;margin-left:6px;">active</span>' : ''}
                        </span>
                        <span class="tpl-item-slaves" style="margin-right:10px;">${f.slave_count} slaves</span>
                        <button class="tpl-btn-sm" style="padding:5px 12px;font-size:0.75rem;background:var(--green);color:white;margin-right:6px;" title="Download" onclick="event.stopPropagation();downloadTemplate('${f.filename}')">&#x2B07;</button>
                        <button class="tpl-btn-sm" style="padding:5px 12px;font-size:0.75rem;background:var(--blue);margin-right:6px;" onclick="event.stopPropagation();editTemplate('${f.filename}')">Edit</button>
                        <button class="tpl-btn-sm" style="padding:5px 8px;font-size:0.85rem;margin-right:6px;background:var(--red);color:white;" title="Remove" onclick="event.stopPropagation();deleteTemplate('${f.filename}')">&#128465;</button>
                        ${isActive
                            ? '<span style="font-size:0.75rem;font-weight:700;color:var(--green);padding:5px 10px;">Active</span>'
                            : `<button class="tpl-btn-sm" style="padding:5px 12px;font-size:0.75rem;" onclick="event.stopPropagation();tplSetActive('${f.filename}')">Set as Active</button>`
                        }
                    </div>`;
                }).join('');
            } catch (e) {
                body.innerHTML = '<div style="color:var(--red);text-align:center;padding:20px;">Error loading templates</div>';
            }
        }

        function openTemplateUpload() {
            const input = document.getElementById('tplUploadInput');
            if (!input) return;
            if (!input.dataset.bound) {
                input.addEventListener('change', async () => {
                    const file = input.files && input.files[0];
                    if (!file) return;
                    await handleTemplateUpload(file);
                });
                input.dataset.bound = '1';
            }
            input.value = '';
            input.click();
        }

        function sanitizeTemplateFilename(name, config) {
            let filename = (name || '').trim();
            if (!filename) {
                const tplName = (config && config.template && config.template.name) ? String(config.template.name).trim() : '';
                filename = tplName || 'template';
            }
            if (!filename.toLowerCase().endsWith('.json')) filename += '.json';
            filename = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
            if (filename === '.json') filename = 'template.json';
            return filename;
        }

        function validateTemplateConfig(config) {
            if (!config || typeof config !== 'object') return { valid: false, msg: 'Root must be an object' };
            if (!config.template || typeof config.template !== 'object') return { valid: false, msg: 'Missing template object' };
            const steps = config.template.steps;
            if (!Array.isArray(steps) || steps.length === 0) return { valid: false, msg: 'template.steps must be a non-empty array' };
            if (!config.positions || typeof config.positions !== 'object') return { valid: false, msg: 'Missing positions object' };
            if (!config.slaves || typeof config.slaves !== 'object') return { valid: false, msg: 'Missing slaves object' };
            const count = parseInt(config.slaves.count, 10);
            if (!Number.isFinite(count) || count <= 0) return { valid: false, msg: 'slaves.count must be > 0' };

            const positionKeys = Object.keys(config.positions || {});
            if (positionKeys.length === 0) return { valid: false, msg: 'positions is empty' };
            let posLen = null;
            for (const key of positionKeys) {
                const arr = config.positions[key];
                if (!Array.isArray(arr)) return { valid: false, msg: `positions.${key} must be an array` };
                if (posLen === null) posLen = arr.length;
                if (arr.length !== posLen) return { valid: false, msg: 'All positions arrays must have the same length' };
            }
            if (!Number.isFinite(posLen) || posLen <= 0) return { valid: false, msg: 'positions arrays are empty' };

            const movementLen = Array.isArray(config.slaves.movement_slaves) ? config.slaves.movement_slaves.length : 0;
            const rotationLen = Array.isArray(config.slaves.rotation_slaves) ? config.slaves.rotation_slaves.length : 0;
            const expectedLen = movementLen > 0 ? movementLen : (rotationLen > 0 ? rotationLen : count);
            if (posLen !== expectedLen) {
                return { valid: false, msg: `positions arrays length ${posLen} does not match expected ${expectedLen}` };
            }

            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];
                if (!step || typeof step !== 'object') return { valid: false, msg: `steps[${i + 1}] must be an object` };
                const posKey = step.position;
                if (!posKey || typeof posKey !== 'string') return { valid: false, msg: `steps[${i + 1}] position is required` };
                if (!Object.prototype.hasOwnProperty.call(config.positions, posKey)) {
                    return { valid: false, msg: `steps[${i + 1}] position "${posKey}" not found in positions` };
                }
                if (step.position_rotation) {
                    const rotKey = step.position_rotation;
                    if (typeof rotKey !== 'string' || !Object.prototype.hasOwnProperty.call(config.positions, rotKey)) {
                        return { valid: false, msg: `steps[${i + 1}] position_rotation "${rotKey}" not found in positions` };
                    }
                }
            }

            return { valid: true };
        }

        async function templateFileExists(filename) {
            const resp = await fetch('/api/configs');
            const data = await resp.json();
            return (data.config_files || []).some(f => f.filename === filename);
        }

        async function handleTemplateUpload(file) {
            let text;
            try {
                text = await file.text();
            } catch (e) {
                showToast('Unable to read file', 'error');
                return;
            }

            let data;
            try {
                data = JSON.parse(text);
            } catch (e) {
                showToast('Invalid JSON: ' + e.message, 'error');
                return;
            }

            const validation = validateTemplateConfig(data);
            if (!validation.valid) {
                showToast('Invalid template: ' + validation.msg, 'error');
                return;
            }

            const filename = sanitizeTemplateFilename(file.name, data);
            try {
                const exists = await templateFileExists(filename);
                if (exists) {
                    const ok = confirm(`Template "${filename.replace('.json', '')}" already exists. Replace it?`);
                    if (!ok) return;
                }
            } catch (e) {
                // If existence check fails, continue with upload attempt.
            }

            try {
                const resp = await fetch('/api/save_template', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename, config: data })
                });
                let result = null;
                try { result = await resp.json(); } catch (e) { }
                if (resp.ok && result && result.success) {
                    showToast('Template uploaded: ' + filename.replace('.json', ''));
                    loadTemplateList();
                } else {
                    const msg = (result && (result.message || result.detail)) || `HTTP ${resp.status}`;
                    showToast('Upload failed: ' + msg, 'error');
                }
            } catch (e) {
                showToast('Upload failed: ' + e.message, 'error');
            }
        }

        // Overlay template list (for disconnected state)
        async function loadOverlayTemplateList() {
            const body = document.getElementById('overlayTplListBody');
            if (!body) return;
            try {
                const [configsResp, defaultResp] = await Promise.all([
                    fetch('/api/configs'),
                    fetch('/api/default_template')
                ]);
                const data = await configsResp.json();
                const defaultData = await defaultResp.json();
                const currentDefault = defaultData.default_template || '';

                const allFiles = (data.config_files || []).filter(f => f.filename !== 'config.json');
                const files = allFiles;

                if (files.length === 0) {
                    body.innerHTML = '<div style="color:var(--text-light);text-align:center;padding:20px;font-size:0.85rem;">No templates yet.<br>Click Create to make one!</div>';
                    return;
                }
                body.innerHTML = files.map(f => {
                    const isActive = f.filename === currentDefault;
                    return `<div class="overlay-tpl-item">
                        <span class="overlay-tpl-name">${f.filename.replace('.json', '')}</span>
                        <div class="overlay-tpl-actions">
                            <button class="overlay-tpl-btn download" onclick="event.stopPropagation();overlayDownloadTemplate('${f.filename}')" title="Download">&#x2B07;</button>
                            <button class="overlay-tpl-btn edit" onclick="event.stopPropagation();overlayEditTemplate('${f.filename}')" title="Edit">Edit</button>
                            <button class="overlay-tpl-btn delete" onclick="event.stopPropagation();overlayDeleteTemplate('${f.filename}')" title="Delete">&#128465;</button>
                            ${isActive ? '<span class="overlay-tpl-btn active-badge">Active</span>' : ''}
                        </div>
                    </div>`;
                }).join('');
            } catch (e) {
                body.innerHTML = '<div style="color:var(--red);text-align:center;padding:20px;font-size:0.85rem;">Error loading</div>';
            }
        }

        async function overlayDownloadTemplate(filename) {
            try {
                const resp = await fetch('/api/load_template?filename=' + encodeURIComponent(filename));
                if (!resp.ok) throw new Error('Failed');
                const data = await resp.json();
                const blob = new Blob([JSON.stringify(data, null, 4)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = filename;
                document.body.appendChild(a); a.click();
                document.body.removeChild(a); URL.revokeObjectURL(url);
                showToast('Downloaded: ' + filename.replace('.json', ''));
            } catch (e) { showToast('Failed: ' + e.message, 'error'); }
        }

        function overlayEditTemplate(filename) {
            setTplEditorMode('overlay', 'list');
            hideInterfaceOverlay();
            // Open pattern page and load template editor
            showPage('pattern');
            setTimeout(() => {
                openTemplateEditor(true);
                editTemplate(filename);
                const list = document.getElementById('tplEditorList');
                if (list) list.style.display = 'none';
            }, 300);
        }

        async function overlayDeleteTemplate(filename) {
            if (!confirm('Delete "' + filename.replace('.json', '') + '"?')) return;
            try {
                const resp = await fetch('/api/delete_template', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename })
                });
                const data = await resp.json();
                if (data.success) {
                    showToast(data.message || 'Template removed');
                    loadOverlayTemplateList();
                } else {
                    showToast('Failed: ' + data.message, 'error');
                }
            } catch (e) { showToast('Error: ' + e.message, 'error'); }
        }

        function showCreateTemplateFromOverlay() {
            setTplEditorMode('overlay', 'create');
            hideInterfaceOverlay();
            showPage('pattern');
            openTemplateEditor(true);
            const list = document.getElementById('tplEditorList');
            if (list) list.style.display = 'none';
            const overlayCreate = document.getElementById('tplCreateOverlay');
            if (overlayCreate) overlayCreate.style.display = 'none';
            openTemplateCreate();
        }

        function backToOverlayTemplates() {
            const overlayCreate = document.getElementById('tplCreateOverlay');
            if (overlayCreate) overlayCreate.style.display = 'none';
            const stepOverlay = document.getElementById('tplStepOverlay');
            if (stepOverlay) stepOverlay.classList.remove('active');
            document.getElementById('tplCreateSection').style.display = 'none';
            document.getElementById('tplEditorList').style.display = 'none';
            closeTemplateEditor();
            showInterfaceOverlay();
        }

        // Overlay template state (separate from run pattern)
        let overlayTplSetup = {};
        let overlayTplSteps = [];
        let overlayTplActiveStep = -1;
        let overlayTplDragPillar = -1;
        let overlayTplDragStartX = 0;
        let overlayTplDragRect = null;
        let overlayTplDragCircle = -1;
        let overlayTplDragCircleStartAngle = 0;
        let overlayTplDragCircleStartVal = 0;
        let overlayTplPillarPositions = [];
        let overlayTplSelectedPillars = [];
        let overlayTplPendingOrderPick = null;
        let overlayTplPendingOrderMoved = false;
        let overlayTplPendingSelectToggle = null;
        let overlayTplPendingSelectMoved = false;
        let overlayTplHomeStepDelay = 2;
        let overlayTplZoom = 1;
        let overlayTplEditingStepNameIdx = -1;
        let overlayTplSimRunning = false;
        let overlayTplSimStep = -1;
        let overlayTplSimLivePositions = null;
        let overlayTplSimLiveRotations = null;
        let overlayTplSimAnimFrame = null;
        let overlayTplSceneCache = null;

        const TPL_FALLBACK_DEFAULTS = {
            hmrs_slider: { track: 5, pillars: 2, width: 0.7, height: 1, maxLeft: 1.5, maxRight: -1.5, maxRot: 45 },
            hmrs: { track: 5, pillars: 2, width: 0.7, height: 1, maxLeft: 1.5, maxRight: -1.5, maxRot: 45 },
            matrix_1row: { track: 2.5, pillars: 3, width: 0.4, height: 0.4, maxLeft: 1.5, maxRight: -1.5, maxRot: 45 },
            matrix_2row: { track: 2.5, pillars: 3, width: 0.4, height: 0.4, maxLeft: 1.5, maxRight: -1.5, maxRot: 45 },
            matrix_3row: { track: 2.5, pillars: 3, width: 0.4, height: 0.4, maxLeft: 1.5, maxRight: -1.5, maxRot: 45 }
        };
        let tplDefaults = null;
        let tplDefaultsLoaded = false;
        let tplDefaultProduct = 'hmrs_slider';

        async function loadTplDefaults() {
            if (tplDefaultsLoaded) return tplDefaults;
            try {
                const resp = await fetch('/api/config');
                const cfg = await resp.json();
                tplDefaults = cfg.template_defaults || null;
                tplDefaultProduct = cfg.product || tplDefaultProduct;
            } catch (e) {
                tplDefaults = null;
            }
            tplDefaultsLoaded = true;
            return tplDefaults;
        }

        function getTplDefaults(product) {
            const defaults = tplDefaults || TPL_FALLBACK_DEFAULTS;
            return defaults[product] || defaults.hmrs_slider;
        }

        function overlayTplNext() {
            console.log('[OVERLAY] Next button clicked');
            const name = document.getElementById('overlayTplName').value.trim();
            if (!name) {
                const input = document.getElementById('overlayTplName');
                const err = document.getElementById('overlayTplNameError');
                if (input) input.classList.add('input-error');
                if (err) err.style.display = 'block';
                showToast('Template name is required', 'error');
                return;
            }

            const product = document.getElementById('overlayTplProduct').value;
            const isHmrs = product === 'hmrs';
            const isMatrix = product.startsWith('matrix_');
            const isHmrsSlider = product === 'hmrs_slider';
            const trackSize = parseFloat(document.getElementById('overlayTplTrackSize').value) || 10;
            const pillarWidth = parseFloat(document.getElementById('overlayTplPillarWidth').value) || 1;
            const pillarCount = parseInt(document.getElementById('overlayTplPillarCount').value) || 1;
            console.log('[OVERLAY] Product:', product, 'Pillars:', pillarCount, 'Track:', trackSize);
            if (!isMatrix && pillarCount * pillarWidth > trackSize) {
                showToast('Pillars don\'t fit in track!');
                return;
            }
            overlayTplSyncAutoAccelDecel();

            const secondDim = (isMatrix || isHmrs || isHmrsSlider) ? (parseFloat(document.getElementById('overlayTplSecondDim').value) || 0.5) : 0;
            const slaveCount = overlayTplGetSlaveCount();
            overlayTplSetup = {
                name,
                product,
                trackSize,
                pillarWidth,
                pillarCount,
                secondDim,
                maxLeft: parseFloat(document.getElementById('overlayTplMaxLeft').value) || (isMatrix ? trackSize : 1.5),
                maxRight: isMatrix ? 0 : (parseFloat(document.getElementById('overlayTplMaxRight').value) || -1.5),
                slaveCount,
                maxRotation: isHmrs ? tplRotationDegToMeters(Math.abs(parseFloat(document.getElementById('overlayTplMaxRotation').value) || 45)) : 0
            };
            console.log('[OVERLAY] overlayTplSetup:', overlayTplSetup);

            overlayTplSteps = [];
            overlayTplActiveStep = -1;
            overlayTplDragPillar = -1;
            overlayTplSelectedPillars = [];

            document.getElementById('tplCreateOverlay').style.display = 'none';

            const rotSpeedSection = document.getElementById('overlayTplRotSpeedSection');
            if (rotSpeedSection) rotSpeedSection.style.display = isHmrs ? '' : 'none';
            const homeToggle = document.getElementById('overlayTplIncludeHomeStep');
            if (homeToggle) homeToggle.checked = true;

            document.getElementById('overlayTplStepTitle').textContent = name + ' - Steps';
            document.getElementById('overlayTplStepOverlay').style.display = 'flex';
            document.getElementById('overlayTplStepsList').innerHTML = '';
            document.getElementById('overlayTplStepHint').textContent = isMatrix
                ? 'Click a LED on track to select, then drag up/down to move'
                : 'Click a pillar to select, then drag to move';

            const c = document.getElementById('overlayTplStepCanvas');
            c.onmousedown = overlayTplCanvasMouseDown;
            c.onmousemove = overlayTplCanvasMouseMove;
            c.onmouseup = overlayTplCanvasMouseUp;
            c.onmouseleave = overlayTplCanvasMouseUp;

            setTimeout(() => overlayTplDrawStepCanvas(), 50);
            console.log('[OVERLAY] Overlay Step Builder opened');
        }

        function overlayTplStepBack() {
            if (overlayTplSimRunning) overlayTplSimStop();
            overlayTplClearPendingOrderPick();
            document.getElementById('overlayTplStepOverlay').style.display = 'none';
            document.getElementById('tplCreateOverlay').style.display = 'flex';

            const c = document.getElementById('overlayTplStepCanvas');
            c.onmousedown = null;
            c.onmousemove = null;
            c.onmouseup = null;
            c.onmouseleave = null;
        }

        function overlayTplUpdateAutoAccelUI() {
            const toggle = document.getElementById('overlayTplAutoAccelToggle');
            const autoOn = !!toggle?.checked;
            const movInputs = document.getElementById('overlayTplAccelDecelInputs');
            const movLine = document.getElementById('overlayTplAccelDecelLine');
            const rotInputs = document.getElementById('overlayTplRotAccelDecelInputs');
            const rotLine = document.getElementById('overlayTplRotAccelDecelLine');
            if (movInputs) movInputs.style.display = autoOn ? 'none' : 'grid';
            if (movLine) movLine.style.display = autoOn ? 'block' : 'none';
            if (rotInputs) rotInputs.style.display = autoOn ? 'none' : 'grid';
            if (rotLine) rotLine.style.display = autoOn ? 'block' : 'none';
            if (autoOn) overlayTplSyncAutoAccelDecel();
        }

        function overlayTplSyncAutoAccelDecel() {
            const velEl = document.getElementById('overlayTplCfgVelocity');
            const accEl = document.getElementById('overlayTplCfgAccel');
            const decEl = document.getElementById('overlayTplCfgDecel');
            const line = document.getElementById('overlayTplAccelDecelLine');
            const rotVelEl = document.getElementById('overlayTplCfgRotVelocity');
            const rotAccEl = document.getElementById('overlayTplCfgRotAccel');
            const rotDecEl = document.getElementById('overlayTplCfgRotDecel');
            const rotLine = document.getElementById('overlayTplRotAccelDecelLine');
            if (!velEl || !accEl || !decEl) return;
            const vel = parseInt(velEl.value) || 0;
            const half = Math.max(0, Math.round(vel / 2));
            const autoOn = !!document.getElementById('overlayTplAutoAccelToggle')?.checked;
            if (autoOn) {
                accEl.value = half;
                decEl.value = half;
                if (line) line.textContent = `Accel-Decel = ${half}`;
            } else {
                if (line) line.textContent = `Accel-Decel = ${accEl.value || half}`;
            }
            if (rotVelEl && rotAccEl && rotDecEl) {
                const rVel = parseInt(rotVelEl.value) || 0;
                const rHalf = Math.max(0, Math.round(rVel / 2));
                if (autoOn) {
                    rotAccEl.value = rHalf;
                    rotDecEl.value = rHalf;
                    if (rotLine) rotLine.textContent = `Accel-Decel = ${rHalf}`;
                } else {
                    if (rotLine) rotLine.textContent = `Accel-Decel = ${rotAccEl.value || rHalf}`;
                }
            }
        }

        function overlayTplZoomIn() {
            overlayTplZoom = Math.min(3, overlayTplZoom + 0.1);
            document.getElementById('overlayTplZoomLabel').textContent = Math.round(overlayTplZoom * 100) + '%';
            overlayTplDrawStepCanvas();
        }

        function overlayTplZoomOut() {
            overlayTplZoom = Math.max(0.3, overlayTplZoom - 0.1);
            document.getElementById('overlayTplZoomLabel').textContent = Math.round(overlayTplZoom * 100) + '%';
            overlayTplDrawStepCanvas();
        }

        function overlayTplClearPendingOrderPick() {
            overlayTplPendingOrderPick = null;
            overlayTplPendingOrderMoved = false;
            overlayTplPendingSelectToggle = null;
            overlayTplPendingSelectMoved = false;
        }

        function overlayTplGetPosCount() {
            const isMatrix = overlayTplSetup.product && overlayTplSetup.product.startsWith('matrix_');
            return isMatrix ? overlayTplSetup.slaveCount : overlayTplSetup.pillarCount;
        }

        function overlayTplGetGlobalSlaveDelay() {
            const el = document.getElementById('overlayTplCfgSlaveDelay');
            const val = parseInt(el ? el.value : '');
            return Number.isFinite(val) ? val : 30;
        }

        function overlayTplGetSlaveCount() {
            const product = document.getElementById('overlayTplProduct')?.value || 'hmrs_slider';
            const pillarCount = parseInt(document.getElementById('overlayTplPillarCount').value) || 1;
            if (product === 'hmrs') return pillarCount * 2;
            if (product === 'matrix_2row') return pillarCount * 2;
            if (product === 'matrix_3row') return pillarCount * 3;
            return pillarCount;
        }

        function applyOverlayTplDefaults(product, isInitial) {
            const d = getTplDefaults(product);

            document.getElementById('overlayTplName').value = '';
            document.getElementById('overlayTplProduct').value = product;
            document.getElementById('overlayTplTrackSize').value = d.track;
            document.getElementById('overlayTplPillarCount').value = d.pillars;
            document.getElementById('overlayTplPillarWidth').value = d.width;
            document.getElementById('overlayTplMaxLeft').value = d.maxLeft;
            document.getElementById('overlayTplMaxRight').value = d.maxRight;
            document.getElementById('overlayTplMaxRotation').value = d.maxRot;

            overlayTplProductChanged();
            tplSyncAutoAccelDecel();
            // Draw preview after defaults are set
            setTimeout(() => drawOverlayTplLayout(), 50);
        }

        function overlayTplAddStep() {
            overlayTplClearPendingOrderPick();
            const n = overlayTplGetPosCount();
            const isHmrs = overlayTplSetup.product === 'hmrs';
            const last = overlayTplSteps.length > 0 ? overlayTplSteps[overlayTplSteps.length - 1] : null;
            const lastSlaveDelay = last ? parseInt(last.slaveDelayMs) : NaN;
            const defaultSlaveDelay = Number.isFinite(lastSlaveDelay) ? lastSlaveDelay : overlayTplGetGlobalSlaveDelay();
            const step = {
                name: `Step ${overlayTplSteps.length + 1}`,
                positions: last ? [...last.positions] : new Array(n).fill(0),
                delay: 2,
                slaveDelayMs: defaultSlaveDelay,
                isIndividualStepDelay: false,
                moveOrderMode: 'dynamic',
                moveOrderList: [],
                saved: false,
                stepType: 'movement'
            };
            if (isHmrs) {
                if (last && last.rotations) step.rotations = [...last.rotations];
                else step.rotations = new Array(overlayTplSetup.pillarCount).fill(0);
            }
            overlayTplSteps.push(step);
            overlayTplActiveStep = overlayTplSteps.length - 1;
            overlayTplPillarPositions = step.positions;
            overlayTplRenderAllStepCards();
            overlayTplDrawStepCanvas();
            const list = document.getElementById('overlayTplStepsList');
            list.scrollTop = list.scrollHeight;
        }

        function overlayTplRemoveStep(idx) {
            overlayTplClearPendingOrderPick();
            overlayTplSteps.splice(idx, 1);
            if (overlayTplActiveStep >= overlayTplSteps.length) overlayTplActiveStep = overlayTplSteps.length - 1;
            overlayTplRenderAllStepCards();
            overlayTplDrawStepCanvas();
        }

        function overlayTplMoveStep(idx, dir) {
            overlayTplClearPendingOrderPick();
            const newIdx = idx + dir;
            if (newIdx < 0 || newIdx >= overlayTplSteps.length) return;
            [overlayTplSteps[idx], overlayTplSteps[newIdx]] = [overlayTplSteps[newIdx], overlayTplSteps[idx]];
            if (overlayTplActiveStep === idx) overlayTplActiveStep = newIdx;
            else if (overlayTplActiveStep === newIdx) overlayTplActiveStep = idx;
            overlayTplRenderAllStepCards();
        }

        function overlayTplSelectStep(idx) {
            overlayTplClearPendingOrderPick();
            overlayTplActiveStep = idx;
            overlayTplEditingStepNameIdx = -1;
            overlayTplDragPillar = -1;
            overlayTplSelectedPillars = [];
            overlayTplRenderAllStepCards();
            overlayTplDrawStepCanvas();
        }

        function overlayTplSaveStep(idx) {
            overlayTplClearPendingOrderPick();
            const v = tplValidatePositions(overlayTplSteps[idx].positions);
            if (!v.valid) {
                showToast('Fix errors before saving: ' + v.msg);
                return;
            }
            overlayTplSteps[idx].saved = true;
            overlayTplActiveStep = -1;
            overlayTplDragPillar = -1;
            overlayTplSelectedPillars = [];
            overlayTplRenderAllStepCards();
            overlayTplDrawStepCanvas();
            showToast('Step ' + (idx + 1) + ' saved');
        }

        function overlayTplEditStep(idx) {
            overlayTplClearPendingOrderPick();
            overlayTplActiveStep = idx;
            overlayTplDragPillar = -1;
            overlayTplSelectedPillars = [];
            overlayTplRenderAllStepCards();
            overlayTplDrawStepCanvas();
        }

        function overlayTplCancelStep(idx) {
            overlayTplClearPendingOrderPick();
            overlayTplSteps[idx].positions = new Array(overlayTplGetPosCount()).fill(0);
            if (overlayTplSteps[idx].rotations) overlayTplSteps[idx].rotations = new Array(overlayTplSetup.pillarCount).fill(0);
            overlayTplUpdateStepCard(idx);
            overlayTplDrawStepCanvas();
        }

        function overlayTplCopyStep(idx) {
            overlayTplClearPendingOrderPick();
            const src = overlayTplSteps[idx];
            const copy = {
                name: src.name || `Step ${idx + 1}`,
                positions: [...src.positions],
                delay: src.delay,
                slaveDelayMs: src.slaveDelayMs,
                isIndividualStepDelay: !!src.isIndividualStepDelay,
                moveOrderMode: src.moveOrderMode,
                moveOrderList: [...(src.moveOrderList || [])],
                saved: false,
                stepType: src.stepType || 'movement'
            };
            if (src.rotations) copy.rotations = [...src.rotations];
            overlayTplSteps.splice(idx + 1, 0, copy);
            overlayTplActiveStep = idx + 1;
            overlayTplRenderAllStepCards();
            overlayTplDrawStepCanvas();
        }

        function overlayTplUpdateStepCard(idx) {
            const card = document.querySelector(`#overlayTplStepsList .tpl-step-card[data-step-index="${idx}"]`);
            if (!card) return;
            const step = overlayTplSteps[idx];
            const sType = step.stepType || 'movement';
            const inputs = card.querySelectorAll('.tpl-step-pos-chip input');
            if (overlayTplSetup.product === 'hmrs' && sType === 'rotation' && step.rotations) {
                inputs.forEach((inp, pi) => { inp.value = Math.round(tplRotationMetersToDeg(step.rotations[pi] || 0) * 10) / 10; });
            } else {
                inputs.forEach((inp, pi) => { inp.value = step.positions[pi]; });
            }
            const v = tplValidatePositions(step.positions);
            const msgEl = card.querySelector('.tpl-validation-msg');
            if (msgEl) msgEl.textContent = v.valid ? '' : v.msg;
            card.classList.toggle('invalid', !v.valid);
        }

        function overlayTplStepPosInput(stepIdx, pillarIdx, el) {
            const val = parseFloat(el.value) || 0;
            overlayTplSteps[stepIdx].positions[pillarIdx] = val;
            overlayTplDrawStepCanvas();
            overlayTplUpdateStepTimeTable();
        }

        function overlayTplStepRotInput(stepIdx, pillarIdx, el) {
            const deg = parseFloat(el.value) || 0;
            const val = tplRotationDegToMeters(deg);
            const maxRot = overlayTplSetup.maxRotation || tplRotationDegToMeters(360);
            const clamped = Math.max(-maxRot, Math.min(maxRot, val));
            if (!overlayTplSteps[stepIdx].rotations) overlayTplSteps[stepIdx].rotations = new Array(overlayTplSetup.pillarCount).fill(0);
            overlayTplSteps[stepIdx].rotations[pillarIdx] = clamped;
            if (el) el.value = Math.round(tplRotationMetersToDeg(clamped) * 10) / 10;
            overlayTplDrawStepCanvas();
            overlayTplUpdateStepTimeTable();
        }

        function overlayTplStepTypeChange(stepIdx, newType) {
            overlayTplSteps[stepIdx].stepType = newType;
            if ((newType === 'rotation' || newType === 'all') && !overlayTplSteps[stepIdx].rotations) {
                overlayTplSteps[stepIdx].rotations = new Array(overlayTplSetup.pillarCount).fill(0);
            }
            overlayTplRenderAllStepCards();
            overlayTplDrawStepCanvas();
        }

        function overlayTplRenderAllStepCards() {
            const list = document.getElementById('overlayTplStepsList');
            let html = '';
            const includeHome = !!document.getElementById('overlayTplIncludeHomeStep')?.checked;
            const showIndividualDelay = tplIsMatrixProduct(overlayTplSetup?.product);
            const globalSlaveDelay = overlayTplGetGlobalSlaveDelay();

            if (includeHome) {
                html += `<div class="tpl-step-card saved">
                    <div class="tpl-step-card-head">
                        <span class="step-num">Home All</span>
                    </div>
                    <div style="font-size:0.78rem;font-weight:600;color:var(--text);margin-top:4px;">Move all to 0m</div>
                    <div class="tpl-step-delay">
                        <span>Delay:</span>
                        <input type="number" step="0.5" min="0" value="${overlayTplHomeStepDelay}" onchange="overlayTplHomeStepDelay=parseFloat(this.value)||0;" onclick="event.stopPropagation()"> sec
                    </div>
                </div>`;
            }

            overlayTplSteps.forEach((step, idx) => {
                const isActive = idx === overlayTplActiveStep;
                const validation = tplValidatePositions(step.positions);
                const invalidClass = !validation.valid ? ' invalid' : '';
                const isHmrs = overlayTplSetup.product === 'hmrs';
                const sType = step.stepType || 'movement';
                const stepSlaveDelay = Number.isFinite(parseInt(step.slaveDelayMs)) ? parseInt(step.slaveDelayMs) : globalSlaveDelay;
                if (showIndividualDelay && !Number.isFinite(parseInt(step.slaveDelayMs))) step.slaveDelayMs = stepSlaveDelay;
                const moveOrderMode = step.moveOrderMode || 'dynamic';
                const moveOrderList = Array.isArray(step.moveOrderList) ? step.moveOrderList : [];
                const canMoveOrder = tplStepAllowsMoveOrder(step);
                const orderLabel = moveOrderList.length > 0 ? moveOrderList.map(i => i + 1).join(' \u2192 ') : '--';

                if (isActive) {
                    const typeSelector = isHmrs ? `<div class="tpl-step-type-row">
                        <label>Step Type:</label>
                        <select onchange="overlayTplStepTypeChange(${idx},this.value)" onclick="event.stopPropagation()">
                            <option value="movement"${sType === 'movement' ? ' selected' : ''}>Movement</option>
                            <option value="rotation"${sType === 'rotation' ? ' selected' : ''}>Rotation</option>
                            <option value="all"${sType === 'all' ? ' selected' : ''}>Movement + Rotation</option>
                        </select>
                    </div>` : '';

                    let posChips = '';
                    if (isHmrs && (sType === 'rotation' || sType === 'all')) {
                        const rots = step.rotations || new Array(overlayTplSetup.pillarCount).fill(0);
                        const maxRotMeters = overlayTplSetup.maxRotation || tplRotationDegToMeters(360);
                        const maxRotDeg = Math.max(0, Math.round(Math.abs(tplRotationMetersToDeg(maxRotMeters)) * 10) / 10);
                        const rotChips = rots.map((v, pi) => `<span class="tpl-step-pos-chip" style="border-color:#f39c12;">
                            <span class="chip-label" style="color:#f39c12;">rot${pi + 1}:</span>
                            <input type="number" step="1" min="${-maxRotDeg}" max="${maxRotDeg}" value="${Math.round(tplRotationMetersToDeg(v) * 10) / 10}" onchange="overlayTplStepRotInput(${idx},${pi},this)" onclick="event.stopPropagation()">°
                        </span>`).join('');
                        if (sType === 'all') {
                            const movChips = step.positions.map((v, pi) => `<span class="tpl-step-pos-chip${!validation.valid ? ' invalid' : ''}">
                                <span class="chip-label">p${pi + 1}s${pi * 2 + 1}:</span>
                                <input type="number" step="0.01" value="${v}" onchange="overlayTplStepPosInput(${idx},${pi},this)" onclick="event.stopPropagation()">
                            </span>`).join('');
                            posChips = `<div style="margin-bottom:6px;font-weight:700;color:#f39c12;font-size:0.75rem;">Rotation</div>${rotChips}
                                <div style="margin:6px 0 4px;font-weight:700;color:#e74c3c;font-size:0.75rem;">Movement</div>${movChips}`;
                        } else {
                            posChips = rotChips;
                        }
                    } else {
                        const isMatrixProduct = overlayTplSetup.product && overlayTplSetup.product.startsWith('matrix_');
                        const matRows = isMatrixProduct ? (parseInt(overlayTplSetup.product.split('_')[1]) || 1) : 1;
                        if (isMatrixProduct && matRows > 1) {
                            for (let t = 0; t < overlayTplSetup.pillarCount; t++) {
                                posChips += `<div style="display:flex;align-items:center;gap:2px;margin-bottom:2px;"><span style="font-size:0.7rem;font-weight:700;color:#555;min-width:22px;">t${t + 1}:</span>`;
                                for (let r = 0; r < matRows; r++) {
                                    const si = t * matRows + r;
                                    const v = step.positions[si] || 0;
                                    posChips += `<span class="tpl-step-pos-chip${!validation.valid ? ' invalid' : ''}" style="margin:0 1px;">
                                        <span class="chip-label">s${si}:</span>
                                        <input type="number" step="0.01" min="0" value="${v}" onchange="overlayTplStepPosInput(${idx},${si},this)" onclick="event.stopPropagation()">
                                    </span>`;
                                }
                                posChips += `</div>`;
                            }
                        } else if (isMatrixProduct) {
                            posChips = step.positions.map((v, pi) => `<span class="tpl-step-pos-chip${!validation.valid ? ' invalid' : ''}">
                                <span class="chip-label">t${pi + 1}:</span>
                                <input type="number" step="0.01" min="0" value="${v}" onchange="overlayTplStepPosInput(${idx},${pi},this)" onclick="event.stopPropagation()">
                            </span>`).join('');
                        } else {
                            posChips = step.positions.map((v, pi) => `<span class="tpl-step-pos-chip${!validation.valid ? ' invalid' : ''}">
                                <span class="chip-label">p${pi + 1}s${isHmrs ? (pi * 2 + 1) : pi}:</span>
                                <input type="number" step="0.01" value="${v}" onchange="overlayTplStepPosInput(${idx},${pi},this)" onclick="event.stopPropagation()">
                            </span>`).join('');
                        }
                    }

                    html += `<div class="tpl-step-card active${invalidClass}" onclick="overlayTplSelectStep(${idx})" data-step-index="${idx}">
                        <div class="tpl-step-card-head">
                            <span class="step-num">${tplGetStepDisplayName(step, idx)} (editing)</span>
                            <div class="tpl-step-card-actions">
                                <button onclick="event.stopPropagation();overlayTplMoveStep(${idx},-1)" title="Move up">&uarr;</button>
                                <button onclick="event.stopPropagation();overlayTplMoveStep(${idx},1)" title="Move down">&darr;</button>
                                <button onclick="event.stopPropagation();overlayTplRemoveStep(${idx})" title="Delete" style="color:var(--red);">&times;</button>
                            </div>
                        </div>
                        ${typeSelector}
                        <div class="tpl-step-positions">${posChips}</div>
                        <div class="tpl-step-delay">
                            <span>Delay:</span>
                            <input type="number" step="0.5" min="0" value="${step.delay}" onchange="overlayTplSteps[${idx}].delay=parseFloat(this.value)||0; overlayTplUpdateStepTimeTable();" onclick="event.stopPropagation()"> sec
                        </div>
                        ${canMoveOrder ? `<div class="tpl-step-move-order">
                            <span>Move Order:</span>
                            <select onchange="overlayTplSteps[${idx}].moveOrderMode=this.value; if(this.value==='dynamic'){overlayTplSteps[${idx}].moveOrderList=[];} overlayTplRenderAllStepCards(); overlayTplDrawStepCanvas();" onclick="event.stopPropagation()">
                                <option value="dynamic"${moveOrderMode === 'dynamic' ? ' selected' : ''}>Dynamic</option>
                                <option value="define"${moveOrderMode === 'define' ? ' selected' : ''}>Define</option>
                            </select>
                            ${moveOrderMode === 'define' ? `<span style="font-size:0.7rem;color:var(--text-light);">Click slaves in order</span>` : ''}
                            ${moveOrderMode === 'define' ? `<span style="font-size:0.7rem;color:var(--text-light);">Order: ${orderLabel}</span>` : ''}
                            ${moveOrderMode === 'define' ? `<button class="tpl-order-clear" onclick="event.stopPropagation();overlayTplSteps[${idx}].moveOrderList=[]; overlayTplRenderAllStepCards(); overlayTplDrawStepCanvas();">Clear</button>` : ''}
                        </div>` : ''}
                        ${showIndividualDelay ? `<div class="tpl-step-slave-delay">
                            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                                <input type="checkbox" ${step.isIndividualStepDelay ? 'checked' : ''} onchange="overlayTplSteps[${idx}].isIndividualStepDelay=this.checked; if(this.checked && !Number.isFinite(parseInt(overlayTplSteps[${idx}].slaveDelayMs))) overlayTplSteps[${idx}].slaveDelayMs=${globalSlaveDelay}; overlayTplRenderAllStepCards(); overlayTplUpdateStepTimeTable();" onclick="event.stopPropagation()">
                                <span>Individual Slave Delay</span>
                            </label>
                            <input type="number" step="1" min="0" value="${step.isIndividualStepDelay ? stepSlaveDelay : globalSlaveDelay}" ${step.isIndividualStepDelay ? '' : 'disabled'} onchange="overlayTplSteps[${idx}].slaveDelayMs=parseInt(this.value)||0; overlayTplUpdateStepTimeTable();" onclick="event.stopPropagation()"> ms
                        </div>` : ''}
                        <div class="tpl-validation-msg">${!validation.valid ? validation.msg : ''}</div>
                        <div class="tpl-step-save-row">
                            <button class="btn-save-step" onclick="event.stopPropagation();overlayTplSaveStep(${idx})">Save Step</button>
                            <button class="btn-cancel-step" onclick="event.stopPropagation();overlayTplCancelStep(${idx})">Reset</button>
                        </div>
                    </div>`;
                } else {
                    let posStr = '';
                    if (isHmrs && sType === 'rotation') {
                        const rots = step.rotations || new Array(overlayTplSetup.pillarCount).fill(0);
                        posStr = rots.map((v, pi) => `rot${pi + 1}: ${tplFormatDeg(v)}`).join(', ');
                    } else if (isHmrs && sType === 'all') {
                        const rots = step.rotations || new Array(overlayTplSetup.pillarCount).fill(0);
                        const rotStr = rots.map((v, pi) => `rot${pi + 1}: ${tplFormatDeg(v)}`).join(', ');
                        const movStr = step.positions.map((v, pi) => `p${pi + 1}: ${v}`).join(', ');
                        posStr = `move(${movStr}) | rot(${rotStr})`;
                    } else {
                        const isMatrixProduct = overlayTplSetup.product && overlayTplSetup.product.startsWith('matrix_');
                        const matR = isMatrixProduct ? (parseInt(overlayTplSetup.product.split('_')[1]) || 1) : 1;
                        if (isMatrixProduct && matR > 1) {
                            const parts = [];
                            for (let t = 0; t < overlayTplSetup.pillarCount; t++) {
                                const vals = [];
                                for (let r = 0; r < matR; r++) vals.push(step.positions[t * matR + r] || 0);
                                parts.push(`t${t + 1}:[${vals.join(',')}]`);
                            }
                            posStr = parts.join(' ');
                        } else {
                            const prefix = isMatrixProduct ? 't' : 'p';
                            posStr = step.positions.map((v, pi) => `${prefix}${pi + 1}: ${v}`).join(', ');
                        }
                    }
                    const typeLabel = isHmrs ? `<span style="font-size:0.7rem;padding:2px 6px;border-radius:6px;background:${sType === 'rotation' ? '#fff3e0;color:#f39c12' : sType === 'all' ? '#e8f7ff;color:#2980b9' : '#ffeaea;color:#e74c3c'};font-weight:700;margin-left:6px;">${sType}</span>` : '';
                    html += `<div class="tpl-step-card${step.saved ? ' saved' : ''}${invalidClass}" data-step-index="${idx}">
                        <div class="tpl-step-card-head">
                            <span class="step-num">${tplGetStepDisplayName(step, idx)}${typeLabel}</span>
                            <div class="tpl-step-card-actions">
                                <button onclick="event.stopPropagation();overlayTplEditStep(${idx})" title="Edit" style="color:var(--blue);font-weight:800;">Edit</button>
                                <button onclick="event.stopPropagation();overlayTplCopyStep(${idx})" title="Copy" style="color:var(--teal);font-weight:800;">Copy</button>
                                <button onclick="event.stopPropagation();overlayTplMoveStep(${idx},-1)" title="Move up">&uarr;</button>
                                <button onclick="event.stopPropagation();overlayTplMoveStep(${idx},1)" title="Move down">&darr;</button>
                                <button onclick="event.stopPropagation();overlayTplRemoveStep(${idx})" title="Delete" style="color:var(--red);">&times;</button>
                            </div>
                        </div>
                        <div style="font-size:0.78rem;font-weight:600;color:var(--text);margin-top:4px;word-break:break-all;">${posStr}</div>
                        <div style="font-size:0.72rem;color:var(--text-light);margin-top:3px;">Delay: ${step.delay}s</div>
                        ${canMoveOrder && moveOrderMode === 'define' ? `<div style="font-size:0.72rem;color:var(--text-light);margin-top:3px;">Order: ${orderLabel}</div>` : ''}
                        ${showIndividualDelay && step.isIndividualStepDelay ? `<div style="font-size:0.72rem;color:var(--text-light);margin-top:3px;">Slave Delay: ${stepSlaveDelay}ms</div>` : ''}
                        <div class="tpl-validation-msg">${!validation.valid ? validation.msg : ''}</div>
                    </div>`;
                }
            });

            list.innerHTML = html;
            overlayTplUpdateStepTimeTable();
        }

        function overlayTplUpdateStepTimeTable() {
            const tbody = document.getElementById('overlayTplStepTimeTableBody');
            if (!tbody) return;

            if (overlayTplSteps.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6">No steps</td></tr>';
                return;
            }

            const includeHome = !!document.getElementById('overlayTplIncludeHomeStep')?.checked;
            const velocity = parseInt(document.getElementById('overlayTplCfgVelocity').value) || 120000;
            const accel = parseInt(document.getElementById('overlayTplCfgAccel').value) || 60000;
            const decel = parseInt(document.getElementById('overlayTplCfgDecel').value) || 60000;

            let html = '';

            if (includeHome) {
                html += `<tr style="color:var(--text-light);">
                    <td>0</td>
                    <td>Home All</td>
                    <td>Home</td>
                    <td>--</td>
                    <td>${overlayTplHomeStepDelay.toFixed(1)}s</td>
                    <td>${overlayTplHomeStepDelay.toFixed(1)}s</td>
                </tr>`;
            }

            overlayTplSteps.forEach((step, idx) => {
                const stepNum = includeHome ? idx + 1 : idx;
                const sType = step.stepType || 'movement';
                const typeLabel = sType === 'rotation' ? 'Rotate' : (sType === 'all' ? 'Move+Rotate' : 'Move');

                const maxPos = Math.max(...step.positions.map(Math.abs));
                const moveTime = velocity > 0 ? (maxPos / (velocity / 60)) : 0;
                const totalTime = moveTime + (step.delay || 0);

                html += `<tr>
                    <td>${stepNum}</td>
                    <td>${tplGetStepDisplayName(step, idx)}</td>
                    <td>${typeLabel}</td>
                    <td>${moveTime.toFixed(2)}s</td>
                    <td>${step.delay.toFixed(1)}s</td>
                    <td>${totalTime.toFixed(2)}s</td>
                </tr>`;
            });

            tbody.innerHTML = html;
        }

        function overlayTplDrawStepCanvas() {
            const canvas = document.getElementById('overlayTplStepCanvas');
            const container = canvas.parentElement;
            const rect = container.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) return;
            const dpr = window.devicePixelRatio || 1;
            const W = rect.width;
            const H = rect.height;
            canvas.width = W * dpr;
            canvas.height = H * dpr;
            canvas.style.width = W + 'px';
            canvas.style.height = H + 'px';
            const ctx = canvas.getContext('2d');
            ctx.scale(dpr, dpr);

            ctx.fillStyle = '#e0e0e0';
            ctx.fillRect(0, 0, W, H);

            const activeStep = (overlayTplActiveStep >= 0 && overlayTplSteps[overlayTplActiveStep]) ? overlayTplSteps[overlayTplActiveStep] : null;
            const orderStep = (overlayTplSimRunning && overlayTplSimStep >= 0 && overlayTplSteps[overlayTplSimStep]) ? overlayTplSteps[overlayTplSimStep] : activeStep;
            const posCount = (overlayTplSetup.product && overlayTplSetup.product.startsWith('matrix_')) ? overlayTplSetup.slaveCount : overlayTplSetup.pillarCount;
            const positions = overlayTplSimRunning && overlayTplSimLivePositions
                ? overlayTplSimLivePositions
                : (activeStep ? activeStep.positions : new Array(posCount).fill(0));

            const drawCfg = { ...overlayTplSetup, zoom: overlayTplZoom };
            if (overlayTplSetup.product === 'hmrs') {
                if (overlayTplSimRunning && overlayTplSimLiveRotations) drawCfg.rotations = overlayTplSimLiveRotations;
                else if (activeStep && activeStep.rotations) drawCfg.rotations = activeStep.rotations;
            }

            const selected = (overlayTplSelectedPillars.length > 0) ? new Set(overlayTplSelectedPillars) : overlayTplDragPillar;
            overlayTplSceneCache = drawTrackScene(ctx, W, H, drawCfg, positions, selected);

            const topRot = overlayTplSetup.product === 'hmrs'
                ? (overlayTplSimRunning && overlayTplSimLiveRotations ? overlayTplSimLiveRotations : (activeStep && activeStep.rotations ? activeStep.rotations : null))
                : null;
            overlayTplDrawTopView(positions, topRot);

            if (orderStep && orderStep.moveOrderMode === 'define' && Array.isArray(orderStep.moveOrderList)) {
                const orderList = orderStep.moveOrderList;
                const rects = overlayTplSceneCache && overlayTplSceneCache.pillarRects ? overlayTplSceneCache.pillarRects : [];
                const getRectBySlaveIdx = (idx) => {
                    for (let i = 0; i < rects.length; i++) {
                        const r = rects[i];
                        const rIdx = (r.slaveIdx !== undefined) ? r.slaveIdx : i;
                        if (rIdx === idx) return r;
                    }
                    return null;
                };
                ctx.save();
                ctx.font = 'bold 11px Nunito, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                orderList.forEach((slaveIdx, orderIdx) => {
                    const r = getRectBySlaveIdx(slaveIdx);
                    if (!r) return;
                    const cx = r.x + r.w / 2;
                    const cy = r.y + r.h / 2;
                    ctx.fillStyle = 'rgba(76, 139, 245, 0.9)';
                    ctx.beginPath();
                    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.fillStyle = '#fff';
                    ctx.fillText(String(orderIdx + 1), cx, cy + 0.5);
                });
                ctx.restore();
            }
        }

        function overlayTplDrawTopView(positions, rotations) {
            const topView = document.getElementById('overlayTplTopView');
            const canvas = document.getElementById('overlayTplTopViewCanvas');
            if (!topView || !canvas) return;

            if (tplIsMatrixProduct(overlayTplSetup?.product)) {
                topView.style.display = 'none';
                return;
            }

            const hasRot = rotations && rotations.length;
            const isHmrs = overlayTplSetup.product === 'hmrs' || hasRot;
            if (!isHmrs) {
                topView.style.display = 'none';
                return;
            }
            topView.style.display = 'block';

            const rect = topView.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) return;
            const dpr = window.devicePixelRatio || 1;
            const W = rect.width;
            const H = rect.height;
            canvas.width = W * dpr;
            canvas.height = H * dpr;
            canvas.style.width = W + 'px';
            canvas.style.height = H + 'px';
            const ctx = canvas.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            ctx.clearRect(0, 0, W, H);
            ctx.fillStyle = '#e6e6e6';
            ctx.fillRect(0, 0, W, H);

            const marginX = 24;
            const trackW = W - marginX * 2;
            const trackH = Math.max(18, H * 0.14);
            const trackY = H / 2 - trackH / 2;

            ctx.fillStyle = '#5b5b5b';
            ctx.fillRect(marginX, trackY, trackW, trackH);

            const n = overlayTplSetup.pillarCount || 1;
            const maxRot = overlayTplSetup.maxRotation || 0.015;
            const rotVals = rotations || new Array(n).fill(0);
            const posVals = positions || new Array(n).fill(0);

            const trackSize = Math.max(0.01, overlayTplSetup.trackSize || 1);
            const mToPx = trackW / trackSize;
            const ledWm = Math.max(0.05, overlayTplSetup.pillarWidth || 0.7);
            const ledW = Math.max(10, ledWm * mToPx);
            const ledH = Math.min(18, Math.max(12, trackH - 4));
            const groupW = n * ledW;
            const groupLeft = marginX + trackW / 2 - groupW / 2;
            const baseY = trackY + trackH / 2 - ledH / 2;

            const leftSeg = Math.max(0, groupLeft - marginX);
            const midSeg = Math.max(0, groupW);
            const rightSeg = Math.max(0, (marginX + trackW) - (groupLeft + groupW));
            ctx.fillStyle = '#7fd88b';
            if (leftSeg > 0) ctx.fillRect(marginX, trackY, leftSeg, trackH);
            if (rightSeg > 0) ctx.fillRect(groupLeft + groupW, trackY, rightSeg, trackH);
            ctx.fillStyle = '#f5d36b';
            if (midSeg > 0) ctx.fillRect(groupLeft, trackY, midSeg, trackH);
            ctx.strokeStyle = '#333';
            ctx.lineWidth = 1;
            ctx.strokeRect(marginX, trackY, trackW, trackH);

            for (let i = 0; i < n; i++) {
                const homeX = groupLeft + i * ledW;
                const offsetPx = -(posVals[i] || 0) * mToPx;
                const x = homeX + offsetPx;
                const y = baseY;

                const rot = rotVals[i] || 0;
                const maxDeg = maxRot > 0 ? tplRotationMetersToDeg(maxRot) : 360;
                const deg = tplRotationMetersToDeg(rot);
                const angleRad = (deg * Math.PI) / 180;

                ctx.fillStyle = '#555';
                ctx.fillRect(x, y, ledW, ledH);
                ctx.strokeStyle = '#333';
                ctx.lineWidth = 1;
                ctx.strokeRect(x, y, ledW, ledH);

                ctx.save();
                ctx.translate(x + ledW / 2, y + ledH / 2);
                ctx.rotate(angleRad);
                ctx.fillStyle = '#fff';
                ctx.fillRect(-2, -ledH / 2, 4, ledH);
                ctx.restore();

                ctx.fillStyle = '#000';
                ctx.font = 'bold 9px Nunito, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(`${i + 1}`, x + ledW / 2, y - 3);
            }
        }

        async function overlayTplSimulate() {
            if (overlayTplSteps.length === 0) {
                showToast('Add at least one step to simulate');
                return;
            }

            const btn = document.getElementById('overlayTplSimBtn');
            btn.textContent = 'Stop';
            btn.onclick = overlayTplSimStop;
            btn.classList.add('running');

            overlayTplSimRunning = true;
            overlayTplSimStep = -1;
            overlayTplSimLivePositions = new Array(overlayTplGetPosCount()).fill(0);
            if (overlayTplSetup.product === 'hmrs') {
                overlayTplSimLiveRotations = new Array(overlayTplSetup.pillarCount).fill(0);
            }

            const includeHome = !!document.getElementById('overlayTplIncludeHomeStep')?.checked;

            for (let i = 0; i < overlayTplSteps.length && overlayTplSimRunning; i++) {
                overlayTplSimStep = i;
                const step = overlayTplSteps[i];
                const velocity = parseInt(document.getElementById('overlayTplCfgVelocity').value) || 120000;

                const startPositions = [...(overlayTplSimLivePositions || new Array(overlayTplGetPosCount()).fill(0))];
                const targetPositions = [...step.positions];
                const maxDist = Math.max(...targetPositions.map((t, j) => Math.abs(t - startPositions[j])));
                const duration = velocity > 0 ? (maxDist / (velocity / 60)) * 1000 : 1000;

                const startTime = performance.now();
                while (overlayTplSimRunning && (performance.now() - startTime) < duration) {
                    const elapsed = performance.now() - startTime;
                    const progress = Math.min(1, elapsed / duration);
                    const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;

                    overlayTplSimLivePositions = startPositions.map((start, j) => {
                        return start + (targetPositions[j] - start) * eased;
                    });

                    if (overlayTplSetup.product === 'hmrs' && step.rotations) {
                        const startRot = overlayTplSimLiveRotations || new Array(overlayTplSetup.pillarCount).fill(0);
                        overlayTplSimLiveRotations = startRot.map((start, j) => {
                            return start + ((step.rotations[j] || 0) - start) * eased;
                        });
                    }

                    overlayTplDrawStepCanvas();
                    await new Promise(r => requestAnimationFrame(r));
                }

                if (!overlayTplSimRunning) break;
                overlayTplSimLivePositions = [...targetPositions];
                if (step.rotations) overlayTplSimLiveRotations = [...step.rotations];
                overlayTplDrawStepCanvas();

                await new Promise(r => setTimeout(r, (step.delay || 2) * 1000));
            }

            overlayTplSimStop();
        }

        function overlayTplSimStop() {
            overlayTplSimRunning = false;
            overlayTplSimStep = -1;
            overlayTplSimLivePositions = null;
            overlayTplSimLiveRotations = null;
            if (overlayTplSimAnimFrame) {
                cancelAnimationFrame(overlayTplSimAnimFrame);
                overlayTplSimAnimFrame = null;
            }

            const btn = document.getElementById('overlayTplSimBtn');
            btn.textContent = 'Simulate';
            btn.onclick = overlayTplSimulate;
            btn.classList.remove('running');

            overlayTplDrawStepCanvas();
        }

        async function overlayTplStepSave() {
            for (let i = 0; i < overlayTplSteps.length; i++) {
                const v = tplValidatePositions(overlayTplSteps[i].positions);
                if (!v.valid) {
                    showToast(`Step ${i + 1} has errors: ${v.msg}`);
                    overlayTplSelectStep(i);
                    return;
                }
            }

            if (overlayTplSteps.length === 0) {
                showToast('Add at least one step');
                return;
            }

            overlayTplSyncAutoAccelDecel();
            const velocity = parseInt(document.getElementById('overlayTplCfgVelocity').value) || 120000;
            const accel = parseInt(document.getElementById('overlayTplCfgAccel').value) || 60000;
            const decel = parseInt(document.getElementById('overlayTplCfgDecel').value) || 60000;
            const slaveDelay = parseInt(document.getElementById('overlayTplCfgSlaveDelay').value) || 30;
            const includeHome = !!document.getElementById('overlayTplIncludeHomeStep')?.checked;
            const useIndividualStepDelay = tplIsMatrixProduct(overlayTplSetup?.product);

            const n = overlayTplSetup.pillarCount;
            const isHmrs = overlayTplSetup.product === 'hmrs';
            const tplMeta = {
                product: overlayTplSetup.product,
                track_size_m: overlayTplSetup.trackSize,
                pillar_count: overlayTplSetup.pillarCount,
                pillar_width_m: overlayTplSetup.pillarWidth,
                second_dim_m: overlayTplSetup.secondDim,
                max_left_m: overlayTplSetup.maxLeft,
                max_right_m: overlayTplSetup.maxRight,
                max_rotation_m: overlayTplSetup.maxRotation,
                slave_count: overlayTplSetup.slaveCount
            };

            let config;

            if (isHmrs) {
                const rotVelocity = parseInt(document.getElementById('overlayTplCfgRotVelocity').value) || 4000;
                const rotAccel = parseInt(document.getElementById('overlayTplCfgRotAccel').value) || 2000;
                const rotDecel = parseInt(document.getElementById('overlayTplCfgRotDecel').value) || 2000;
                const rotCspMax = parseInt(document.getElementById('overlayTplCfgRotCspMax').value) || 50;

                const totalSlaves = n * 2;
                const slaveNames = [];
                const rotationSlaves = [];
                const movementSlaves = [];
                for (let i = 0; i < n; i++) {
                    slaveNames.push('Rotation ' + (i + 1));
                    slaveNames.push('Movement ' + (i + 1));
                    rotationSlaves.push(i * 2);
                    movementSlaves.push(i * 2 + 1);
                }

                const positions = {};
                positions['home_pos_M'] = new Array(n).fill(0);
                let movCounter = 0;
                let rotCounter = 0;
                overlayTplSteps.forEach((step, idx) => {
                    const sType = step.stepType || 'movement';
                    if (sType === 'rotation' || sType === 'all') {
                        rotCounter++;
                        positions['rot_' + rotCounter] = [...(step.rotations || new Array(n).fill(0))];
                    }
                    if (sType === 'movement' || sType === 'all') {
                        movCounter++;
                        positions['pos_' + movCounter] = [...step.positions];
                    }
                });

                const steps = [];
                if (includeHome) {
                    steps.push({ name: 'Home All', type: 'home', position: 'home_pos_M', delay: overlayTplHomeStepDelay });
                }
                let mIdx = 0, rIdx = 0;
                overlayTplSteps.forEach((step, idx) => {
                    const sType = step.stepType || 'movement';
                    const baseName = tplGetStepDisplayName(step, idx);
                    const moveOrderMode = step.moveOrderMode || 'dynamic';
                    const moveOrderList = tplMapMoveOrderForSave(Array.isArray(step.moveOrderList) ? step.moveOrderList : []);
                    if (sType === 'rotation') {
                        rIdx++;
                        steps.push({
                            name: baseName + ' (Rotate)',
                            type: 'rotation',
                            position: 'rot_' + rIdx,
                            delay: step.delay
                        });
                    } else if (sType === 'all') {
                        rIdx++;
                        mIdx++;
                        steps.push({
                            name: baseName + ' (Move+Rotate)',
                            type: 'all',
                            position: 'pos_' + mIdx,
                            position_rotation: 'rot_' + rIdx,
                            delay: step.delay,
                            move_order: moveOrderMode,
                            move_order_list: moveOrderMode === 'define' ? moveOrderList : undefined
                        });
                    } else {
                        mIdx++;
                        steps.push({
                            name: baseName + ' (Move)',
                            type: 'movement',
                            position: 'pos_' + mIdx,
                            delay: step.delay,
                            move_order: moveOrderMode,
                            move_order_list: moveOrderMode === 'define' ? moveOrderList : undefined
                        });
                    }
                });

                config = {
                    speed: {
                        movement_speed: {
                            velocity,
                            acceleration: accel,
                            deceleration: decel,
                            csp_max_step: 100
                        },
                        rotation_speed: {
                            velocity: rotVelocity,
                            acceleration: rotAccel,
                            deceleration: rotDecel,
                            csp_max_step: rotCspMax
                        }
                    },
                    slaves: {
                        count: totalSlaves,
                        names: slaveNames,
                        movement_slaves: movementSlaves,
                        rotation_slaves: rotationSlaves
                    },
                    positions,
                    template: {
                        name: overlayTplSetup.name,
                        description: '',
                        operation_mode: 'both',
                        is_simultaneous: true,
                        slave_delay_ms: slaveDelay,
                        left_end_position: overlayTplSetup.maxLeft,
                        right_end_position: overlayTplSetup.maxRight,
                        meta: tplMeta,
                        steps
                    }
                };
            } else {
                const slaveNames = [];
                for (let i = 0; i < n; i++) slaveNames.push('Movement ' + (i + 1));
                const movementSlaves = Array.from({ length: n }, (_, i) => i);

                const positions = {};
                positions['home_pos_M'] = new Array(n).fill(0);
                overlayTplSteps.forEach((step, idx) => {
                    positions['pos_' + (idx + 1)] = [...step.positions];
                });

                const steps = [];
                if (includeHome) {
                    steps.push({ name: 'Home All', type: 'home', position: 'home_pos_M', delay: overlayTplHomeStepDelay });
                }
                overlayTplSteps.forEach((step, idx) => {
                    const parsedStepSlaveDelay = parseInt(step.slaveDelayMs);
                    const stepSlaveDelay = (useIndividualStepDelay && step.isIndividualStepDelay)
                        ? (Number.isFinite(parsedStepSlaveDelay) ? parsedStepSlaveDelay : slaveDelay)
                        : slaveDelay;
                    const moveOrderMode = step.moveOrderMode || 'dynamic';
                    const moveOrderList = tplMapMoveOrderForSave(Array.isArray(step.moveOrderList) ? step.moveOrderList : []);
                    steps.push({
                        name: tplGetStepDisplayName(step, idx),
                        type: 'movement',
                        position: 'pos_' + (idx + 1),
                        delay: step.delay,
                        move_order: moveOrderMode,
                        move_order_list: moveOrderMode === 'define' ? moveOrderList : undefined,
                        is_simultaneous: false,
                        slave_delay_ms: stepSlaveDelay,
                        is_individual_step_delay: !!(useIndividualStepDelay && step.isIndividualStepDelay)
                    });
                });

                config = {
                    speed: {
                        movement_speed: {
                            velocity,
                            acceleration: accel,
                            deceleration: decel,
                            csp_max_step: 100
                        }
                    },
                    slaves: {
                        count: n,
                        names: slaveNames,
                        movement_slaves: movementSlaves
                    },
                    positions,
                    template: {
                        name: overlayTplSetup.name,
                        description: '',
                        operation_mode: 'movement',
                        is_simultaneous: false,
                        slave_delay_ms: slaveDelay,
                        left_end_position: overlayTplSetup.maxLeft,
                        right_end_position: overlayTplSetup.maxRight,
                        meta: tplMeta,
                        steps
                    }
                };
            }

            try {
                const filename = overlayTplSetup.name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
                const response = await fetch('/api/save_template', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename, config })
                });

                if (response.ok) {
                    showToast('Template saved: ' + filename);
                    overlayTplStepBack();
                } else {
                    const error = await response.json();
                    showToast('Save failed: ' + (error.detail || 'Unknown error'), 'error');
                }
            } catch (e) {
                showToast('Save failed: ' + e.message, 'error');
            }
        }

        function overlayTplCanvasMouseDown(e) {
            if (overlayTplActiveStep < 0) return;
            if (!overlayTplSceneCache) return;
            const rect = e.target.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;

            const step = overlayTplSteps[overlayTplActiveStep];
            const isHmrs = overlayTplSetup.product === 'hmrs';
            const sType = step.stepType || 'movement';
            const allowMoveOrderPick = tplStepAllowsMoveOrder(step) && step.moveOrderMode === 'define' && !(e.shiftKey || e.ctrlKey || e.metaKey);

            // HMRS rotation step: hit test circles first
            if (isHmrs && (sType === 'rotation' || sType === 'all') && overlayTplSceneCache.circleRects) {
                for (let i = overlayTplSceneCache.circleRects.length - 1; i >= 0; i--) {
                    const c = overlayTplSceneCache.circleRects[i];
                    const dist = Math.sqrt((mx - c.cx) ** 2 + (my - c.cy) ** 2);
                    if (dist <= c.r + 4) {
                        overlayTplDragCircle = c.idx;
                        overlayTplDragCircleStartAngle = Math.atan2(my - c.cy, mx - c.cx);
                        if (!step.rotations) step.rotations = new Array(overlayTplSetup.pillarCount).fill(0);
                        overlayTplDragCircleStartVal = step.rotations[c.idx] || 0;
                        overlayTplDragPillar = c.idx;
                        e.target.classList.add('dragging');
                        overlayTplDrawStepCanvas();
                        return;
                    }
                }
            }

            // Hit test pillars/tracks (movement)
            if (!isHmrs || sType === 'movement' || sType === 'all') {
                for (let i = overlayTplSceneCache.pillarRects.length - 1; i >= 0; i--) {
                    const r = overlayTplSceneCache.pillarRects[i];
                    if (r.isVertical) {
                        if (mx >= r.x - 5 && mx <= r.x + r.w + 5 && my >= r.y && my <= r.y + r.h) {
                            const idx = r.slaveIdx !== undefined ? r.slaveIdx : i;
                            if (allowMoveOrderPick) {
                                overlayTplPendingOrderPick = { idx, startX: mx, startY: my };
                                overlayTplPendingOrderMoved = false;
                                overlayTplDragPillar = idx;
                                overlayTplDragRect = { ...r };
                                overlayTplDragStartX = my;
                                e.target.classList.add('dragging');
                                overlayTplDrawStepCanvas();
                                return;
                            }
                            const ctrlMulti = e.ctrlKey || e.metaKey;
                            if (ctrlMulti) {
                                const pos = overlayTplSelectedPillars.indexOf(idx);
                                const wasSelected = pos >= 0;
                                if (!wasSelected) overlayTplSelectedPillars.push(idx);
                                overlayTplPendingSelectToggle = { idx, startX: mx, startY: my, wasSelected, ctrlAtStart: true };
                                overlayTplPendingSelectMoved = false;
                            } else {
                                const isAlreadySelected = overlayTplSelectedPillars.includes(idx);
                                if (!isAlreadySelected) overlayTplSelectedPillars = [idx];
                                overlayTplPendingSelectToggle = null;
                                overlayTplPendingSelectMoved = false;
                            }
                            overlayTplDragPillar = idx;
                            overlayTplDragRect = { ...r };
                            overlayTplDragStartX = my;
                            e.target.classList.add('dragging');
                            overlayTplDrawStepCanvas();
                            return;
                        }
                    } else if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) {
                        const idx = i;
                        if (allowMoveOrderPick) {
                            overlayTplPendingOrderPick = { idx, startX: mx, startY: my };
                            overlayTplPendingOrderMoved = false;
                            overlayTplDragPillar = idx;
                            overlayTplDragStartX = mx;
                            e.target.classList.add('dragging');
                            overlayTplDrawStepCanvas();
                            return;
                        }
                        const ctrlMulti = e.ctrlKey || e.metaKey;
                        if (ctrlMulti) {
                            const pos = overlayTplSelectedPillars.indexOf(idx);
                            const wasSelected = pos >= 0;
                            if (!wasSelected) overlayTplSelectedPillars.push(idx);
                            overlayTplPendingSelectToggle = { idx, startX: mx, startY: my, wasSelected, ctrlAtStart: true };
                            overlayTplPendingSelectMoved = false;
                        } else {
                            const isAlreadySelected = overlayTplSelectedPillars.includes(idx);
                            if (!isAlreadySelected) overlayTplSelectedPillars = [idx];
                            overlayTplPendingSelectToggle = null;
                            overlayTplPendingSelectMoved = false;
                        }
                        overlayTplDragPillar = idx;
                        overlayTplDragStartX = mx;
                        e.target.classList.add('dragging');
                        overlayTplDrawStepCanvas();
                        return;
                    }
                }
                if (!(e.ctrlKey || e.metaKey)) {
                    overlayTplSelectedPillars = [];
                    overlayTplDrawStepCanvas();
                }
            }
        }

        function overlayTplCanvasMouseMove(e) {
            if (overlayTplActiveStep < 0) return;
            if (!overlayTplSceneCache) return;

            const canvas = e.target;
            if (overlayTplPendingOrderPick) {
                const hr = canvas.getBoundingClientRect();
                const hx = e.clientX - hr.left;
                const hy = e.clientY - hr.top;
                const dx = Math.abs(hx - overlayTplPendingOrderPick.startX);
                const dy = Math.abs(hy - overlayTplPendingOrderPick.startY);
                if (dx < 4 && dy < 4) return;
                overlayTplPendingOrderMoved = true;
                overlayTplPendingOrderPick = null;
            }

            if (overlayTplPendingSelectToggle) {
                const hr = canvas.getBoundingClientRect();
                const hx = e.clientX - hr.left;
                const hy = e.clientY - hr.top;
                const dx = Math.abs(hx - overlayTplPendingSelectToggle.startX);
                const dy = Math.abs(hy - overlayTplPendingSelectToggle.startY);
                if (dx < 4 && dy < 4) return;
                overlayTplPendingSelectMoved = true;
            }

            // Update hover cursor for HMRS rotation circles
            if (overlayTplDragCircle < 0 && overlayTplDragPillar < 0 && overlayTplSceneCache.circleRects && overlayTplSceneCache.circleRects.length > 0) {
                const hr = canvas.getBoundingClientRect();
                const hx = e.clientX - hr.left;
                const hy = e.clientY - hr.top;
                const step = overlayTplSteps[overlayTplActiveStep];
                const sType = step ? (step.stepType || 'movement') : 'movement';
                let overCircle = false;
                if (overlayTplSetup.product === 'hmrs' && (sType === 'rotation' || sType === 'all')) {
                    for (const c of overlayTplSceneCache.circleRects) {
                        if (Math.sqrt((hx - c.cx) ** 2 + (hy - c.cy) ** 2) <= c.r + 4) {
                            overCircle = true;
                            break;
                        }
                    }
                }
                canvas.style.cursor = overCircle ? 'grab' : '';
            }

            // HMRS rotation circle drag
            if (overlayTplDragCircle >= 0) {
                const rect = e.target.getBoundingClientRect();
                const mx = e.clientX - rect.left;
                const my = e.clientY - rect.top;
                const circ = overlayTplSceneCache.circleRects.find(c => c.idx === overlayTplDragCircle);
                if (!circ) return;

                const currentAngle = Math.atan2(my - circ.cy, mx - circ.cx);
                let angleDiff = currentAngle - overlayTplDragCircleStartAngle;
                if (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
                if (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

                const maxRot = overlayTplSetup.maxRotation || 0.015;
                const fullCircleMeters = tplRotationDegToMeters(360);
                const valueDelta = (angleDiff / (Math.PI * 2)) * fullCircleMeters;
                let newVal = Math.round((overlayTplDragCircleStartVal + valueDelta) * 1000) / 1000;
                newVal = Math.max(-maxRot, Math.min(maxRot, newVal));

                const step = overlayTplSteps[overlayTplActiveStep];
                if (!step.rotations) step.rotations = new Array(overlayTplSetup.pillarCount).fill(0);
                step.rotations[overlayTplDragCircle] = newVal;

                overlayTplDrawStepCanvas();
                overlayTplUpdateStepCard(overlayTplActiveStep);
                return;
            }

            // Movement pillar/track drag
            if (overlayTplDragPillar < 0) return;
            const rect = e.target.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;

            const step = overlayTplSteps[overlayTplActiveStep];
            const snapOn = e.shiftKey;
            const isMatrix = overlayTplSetup.product && overlayTplSetup.product.startsWith('matrix_');
            const pillarRect = (isMatrix && overlayTplDragRect) ? overlayTplDragRect : overlayTplSceneCache.pillarRects[overlayTplDragPillar];

            if (isMatrix && pillarRect && pillarRect.isVertical) {
                const dy = my - overlayTplDragStartX;
                const dMeters = -dy / pillarRect.vMToPixel;
                const maxMovement = overlayTplSetup.maxLeft || overlayTplSetup.trackSize;
                const matRows = parseInt((overlayTplSetup.product || '').split('_')[1]) || 1;
                const selected = (overlayTplSelectedPillars && overlayTplSelectedPillars.length > 0) ? new Set(overlayTplSelectedPillars) : new Set([overlayTplDragPillar]);
                const updated = step.positions.map((v, i) => {
                    if (selected.has(i)) {
                        let nextVal = Math.round((v + dMeters) * 100) / 100;
                        nextVal = Math.max(0, Math.min(maxMovement, nextVal));
                        if (snapOn) nextVal = tplSnapToRuler(nextVal);
                        return Math.max(0, Math.min(maxMovement, nextVal));
                    }
                    return v;
                });

                if (matRows > 1) {
                    const trackCount = overlayTplSetup.pillarCount || 1;
                    for (let t = 0; t < trackCount; t++) {
                        const start = t * matRows;
                        for (let r = 1; r < matRows; r++) {
                            if (updated[start + r] > updated[start + r - 1]) {
                                updated[start + r] = updated[start + r - 1];
                            }
                        }
                        for (let r = matRows - 2; r >= 0; r--) {
                            if (updated[start + r] < updated[start + r + 1]) {
                                updated[start + r] = updated[start + r + 1];
                            }
                        }
                    }
                }

                selected.forEach(i => {
                    step.positions[i] = updated[i];
                });
                overlayTplDragStartX = my;
            } else {
                const dx = mx - overlayTplDragStartX;
                const dMeters = dx / (overlayTplSceneCache.mToPixel || 1);
                const maxMovement = overlayTplSetup.maxLeft || overlayTplSetup.trackSize;
                const minMovement = overlayTplSetup.maxRight || 0;
                const selected = (overlayTplSelectedPillars && overlayTplSelectedPillars.length > 0) ? overlayTplSelectedPillars : [overlayTplDragPillar];

                selected.forEach(i => {
                    let nextVal = Math.round((step.positions[i] + dMeters) * 100) / 100;
                    nextVal = Math.max(minMovement, Math.min(maxMovement, nextVal));
                    if (snapOn) nextVal = tplSnapToRuler(nextVal);
                    step.positions[i] = Math.max(minMovement, Math.min(maxMovement, nextVal));
                });
                overlayTplDragStartX = mx;
            }

            overlayTplDrawStepCanvas();
            overlayTplUpdateStepCard(overlayTplActiveStep);
        }

        function overlayTplCanvasMouseUp(e) {
            if (overlayTplPendingOrderPick && !overlayTplPendingOrderMoved) {
                const step = overlayTplSteps[overlayTplActiveStep];
                if (step && step.moveOrderMode === 'define') {
                    if (!Array.isArray(step.moveOrderList)) step.moveOrderList = [];
                    const idx = overlayTplPendingOrderPick.idx;
                    const existingPos = step.moveOrderList.indexOf(idx);
                    if (existingPos >= 0) {
                        step.moveOrderList.splice(existingPos, 1);
                    } else {
                        step.moveOrderList.push(idx);
                    }
                    overlayTplDrawStepCanvas();
                    overlayTplUpdateStepCard(overlayTplActiveStep);
                }
            }

            if (overlayTplPendingSelectToggle && !overlayTplPendingSelectMoved) {
                const { idx, wasSelected } = overlayTplPendingSelectToggle;
                if (wasSelected) {
                    const pos = overlayTplSelectedPillars.indexOf(idx);
                    if (pos >= 0) overlayTplSelectedPillars.splice(pos, 1);
                }
                overlayTplDrawStepCanvas();
            }

            overlayTplPendingOrderPick = null;
            overlayTplPendingOrderMoved = false;
            overlayTplPendingSelectToggle = null;
            overlayTplPendingSelectMoved = false;
            overlayTplDragCircle = -1;
            overlayTplDragPillar = -1;
            overlayTplDragRect = null;
            e.target.classList.remove('dragging');
        }

        async function tplSetActive(filename) {
            try {
                const resp = await fetch('/api/default_template', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ default_template: filename })
                });
                const data = await resp.json();
                if (data.success) {
                    defaultTemplateName = filename;
                    const display = document.getElementById('templateNameDisplay');
                    if (display) display.textContent = filename.replace('.json', '');
                    showToast('Active template: ' + filename.replace('.json', ''));
                    updateTemplateMismatchUI();
                    if (currentPage === 'pattern') {
                        sendCmd('load_config', { filename: filename });
                    }
                    loadTemplateList(); // refresh to show updated state
                } else {
                    showToast('Failed: ' + data.message);
                }
            } catch (e) {
                showToast('Error: ' + e.message);
            }
        }

        async function deleteTemplate(filename) {
            if (!confirm(`Move template "${filename}" to deleted?`)) return;
            try {
                const resp = await fetch('/api/delete_template', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename })
                });
                const data = await resp.json();
                if (data.success) {
                    if (defaultTemplateName === filename) {
                        defaultTemplateName = '';
                        const display = document.getElementById('templateNameDisplay');
                        if (display) display.textContent = 'No active template selected';
                        updateTemplateMismatchUI();
                    }
                    showToast(data.message || 'Template removed');
                    loadTemplateList();
                } else {
                    showToast('Failed: ' + (data.message || 'delete failed'), 'error');
                }
            } catch (e) {
                showToast('Error: ' + e.message, 'error');
            }
        }

        async function openTemplateCreate() {
            tplEditingFile = null;
            document.getElementById('tplCreateTitle').textContent = 'Create New Template';
            document.getElementById('tplEditorList').style.display = 'none';
            document.getElementById('tplCreateSection').style.display = 'block';

            document.getElementById('tplName').value = '';
            await loadTplDefaults();
            document.getElementById('tplProduct').value = tplDefaultProduct || 'hmrs_slider';
            document.getElementById('tplIncludeHomeStep').checked = true;
            tplHomeStepDelay = 2;
            tplProductChanged();
            tplSyncAutoAccelDecel();
        }

        function showCreateTemplate() {
            setTplEditorMode('main', 'create');
            openTemplateCreate();
        }

        async function downloadTemplate(filename) {
            try {
                const resp = await fetch('/api/load_template?filename=' + encodeURIComponent(filename));
                if (!resp.ok) { throw new Error('Failed to load template'); }
                const data = await resp.json();
                const blob = new Blob([JSON.stringify(data, null, 4)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                showToast('Downloaded: ' + filename.replace('.json', ''));
            } catch (e) {
                showToast('Download failed: ' + e.message, 'error');
            }
        }

        async function editTemplate(filename) {
            tplEditingFile = filename;

            try {
                const resp = await fetch('/api/load_template?filename=' + encodeURIComponent(filename));
                const cfg = await resp.json();

                const slaveCount = cfg.slaves?.count || 1;
                const tpl = cfg.template || {};
                const meta = tpl.meta || tpl.ui_setup || tpl.setup || {};
                const leftEnd = tpl.left_end_position || 0;
                const rightEnd = tpl.right_end_position || 0;
                const maxLeft = (meta.max_left_m !== undefined) ? meta.max_left_m : Math.max(leftEnd, rightEnd);
                const maxRight = (meta.max_right_m !== undefined) ? meta.max_right_m : Math.min(leftEnd, rightEnd);

                const product = meta.product || 'hmrs_slider';
                const isMatrix = tplIsMatrixProduct(product);
                const rows = isMatrix ? (parseInt(product.split('_')[1]) || 1) : 1;
                const pillarCount = parseInt(meta.pillar_count) || (isMatrix ? Math.max(1, Math.floor(slaveCount / rows)) : slaveCount);
                const pillarWidth = parseFloat(meta.pillar_width_m) || 1;
                const secondDim = (meta.second_dim_m !== undefined) ? meta.second_dim_m : 0.5;
                const maxRotation = (meta.max_rotation_m !== undefined) ? meta.max_rotation_m : 0.015;
                const trackSize = (meta.track_size_m !== undefined)
                    ? meta.track_size_m
                    : (() => {
                        const pillarsTotal = pillarCount * pillarWidth;
                        return Math.max(pillarsTotal + Math.abs(maxLeft) + Math.abs(maxRight), pillarsTotal + 2);
                    })();

                // Build tplSetup
            tplSetup = {
                name: tpl.name || filename.replace('.json', ''),
                product,
                trackSize,
                pillarWidth,
                pillarCount,
                secondDim,
                maxLeft,
                maxRight: isMatrix ? 0 : maxRight,
                slaveCount,
                maxRotation
            };

                // Populate config fields
                const speed = cfg.speed?.movement_speed || {};
                document.getElementById('tplCfgVelocity').value = speed.velocity || 120000;
                document.getElementById('tplCfgAccel').value = speed.acceleration || 60000;
                document.getElementById('tplCfgDecel').value = speed.deceleration || 60000;
                tplSyncAutoAccelDecel();
                document.getElementById('tplCfgSlaveDelay').value = tpl.slave_delay_ms || 30;
                const globalDelay = parseInt(document.getElementById('tplCfgSlaveDelay').value) || 30;

                // Build steps from template (skip home steps)
                tplSteps = [];
                const positions = cfg.positions || {};
                const isHmrs = product === 'hmrs';
                (tpl.steps || []).forEach(s => {
                    if (s.type === 'home') return; // skip home steps
                    const posKey = s.position || '';
                    const baseCount = isHmrs ? tplSetup.pillarCount : slaveCount;
                    const posValues = positions[posKey] || new Array(baseCount).fill(0);
                    const isIndividual = !!s.is_individual_step_delay || !!s.isIndividualStepDelay
                        || (s.slave_delay_ms !== undefined && s.slave_delay_ms !== globalDelay);
                    const step = {
                        name: s.name || `Step ${tplSteps.length + 1}`,
                        positions: [...posValues],
                        delay: s.delay || 2,
                        slaveDelayMs: (s.slave_delay_ms !== undefined ? s.slave_delay_ms : globalDelay),
                        isIndividualStepDelay: isIndividual,
                        moveOrderMode: s.move_order || 'dynamic',
                        moveOrderList: tplMapMoveOrderForEdit(Array.isArray(s.move_order_list) ? [...s.move_order_list] : []),
                        saved: true
                    };
                    if (isHmrs) {
                        const sType = s.type || 'movement';
                        step.stepType = sType;
                        if (sType === 'rotation' || sType === 'all') {
                            const rotKey = s.position_rotation || posKey;
                            const rotValues = positions[rotKey] || new Array(tplSetup.pillarCount).fill(0);
                            step.rotations = [...rotValues];
                        }
                        if (sType === 'rotation') {
                            step.positions = new Array(tplSetup.pillarCount).fill(0);
                        }
                    }
                    tplSteps.push(step);
                });

                tplActiveStep = -1;
                tplDragPillar = -1;

                // Open step builder overlay directly
                document.getElementById('tplStepTitle').textContent = tplSetup.name + ' - Steps';
                document.getElementById('tplStepOverlay').classList.add('active');
                const hasHome = (tpl.steps || []).some(s => s.type === 'home');
                const homeStep = (tpl.steps || []).find(s => s.type === 'home');
                tplHomeStepDelay = homeStep ? (homeStep.delay || 2) : 2;
                const homeToggle = document.getElementById('tplIncludeHomeStep');
                if (homeToggle) homeToggle.checked = !!hasHome;
                const hint = document.getElementById('tplStepHint');
                if (hint) {
                    hint.textContent = isMatrix
                        ? 'Click a LED on track to select, then drag up/down to move'
                        : 'Click a pillar to select, then drag to move';
                }
                tplUpdateSpeedTestUI();
                tplUpdateSpeedTestSlaveOptions();
                const panel = document.getElementById('tplSpeedTestPanel');
                if (panel) panel.style.display = 'none';

                const c = document.getElementById('tplStepCanvas');
                c.onmousedown = tplCanvasMouseDown;
                c.onmousemove = tplCanvasMouseMove;
                c.onmouseup = tplCanvasMouseUp;
                c.onmouseleave = tplCanvasMouseUp;

                tplRenderAllStepCards();
                setTimeout(() => drawTplStepCanvas(), 50);

            } catch (e) {
                showToast('Error loading template: ' + e.message);
            }
        }

        function backToTemplateList() {
            if (tplEditorMode === 'overlay') {
                backToOverlayTemplates();
                return;
            }
            document.getElementById('tplCreateSection').style.display = 'none';
            document.getElementById('tplEditorList').style.display = '';
            loadTemplateList();
        }

        function applyTplDefaults(product, force = false) {
            const d = getTplDefaults(product);

            const setIf = (id, val) => {
                const el = document.getElementById(id);
                if (!el) return;
                if (force || el.value === '' || el.value == null) el.value = val;
            };

            setIf('tplTrackSize', d.track);
            setIf('tplPillarCount', d.pillars);
            setIf('tplPillarWidth', d.width);
            setIf('tplSecondDim', d.height);
            setIf('tplMaxLeft', d.maxLeft);
            setIf('tplMaxRight', d.maxRight);
            setIf('tplMaxRotation', d.maxRot);
        }

        function clearTplNameError() {
            const input = document.getElementById('tplName');
            const err = document.getElementById('tplNameError');
            if (input) input.classList.remove('input-error');
            if (err) err.style.display = 'none';
        }

        function clearOverlayTplNameError() {
            const input = document.getElementById('overlayTplName');
            const err = document.getElementById('overlayTplNameError');
            if (input) input.classList.remove('input-error');
            if (err) err.style.display = 'none';
        }

        function tplProductChanged() {
            const product = document.getElementById('tplProduct').value;
            applyTplDefaults(product, true);
            const isHmrs = product === 'hmrs';
            const isHmrsSlider = product === 'hmrs_slider';
            const isMatrix = product.startsWith('matrix_');
            document.getElementById('tplRotationDegreeGroup').style.display = isHmrs ? '' : 'none';

            // Update labels based on product type
            const secDimGroup = document.getElementById('tplSecondDimGroup');
            const secDimLabel = document.getElementById('tplSecondDimLabel');
            if (isMatrix) {
                document.getElementById('tplPillarLabel').textContent = 'No. of Tracks';
                document.getElementById('tplTrackSizeLabel').textContent = 'Track Length (m)';
                document.getElementById('tplPillarWidthLabel').textContent = 'LED/TV Height (m)';
                secDimLabel.textContent = 'LED/TV Width (m)';
                secDimGroup.style.display = '';
                document.getElementById('tplMaxLeftLabel').innerHTML = 'Max Distance Top (m) <span id="tplMaxLeftHint" class="tpl-avail-info"></span>';
                document.getElementById('tplMaxRightLabel').style.display = 'none';
                document.getElementById('tplMaxRight').parentElement.style.display = 'none';
            } else if (isHmrs) {
                document.getElementById('tplPillarLabel').textContent = 'No. of Pillars';
                document.getElementById('tplTrackSizeLabel').textContent = 'Track Size (m)';
                document.getElementById('tplPillarWidthLabel').textContent = 'Pillar Width (m)';
                secDimLabel.textContent = 'LED/TV Height (m)';
                secDimGroup.style.display = '';
                document.getElementById('tplMaxLeftLabel').innerHTML = 'Max Distance Left (m) <span id="tplMaxLeftHint" class="tpl-avail-info"></span>';
                document.getElementById('tplMaxRightLabel').innerHTML = 'Max Distance Right (m) <span id="tplMaxRightHint" class="tpl-avail-info"></span>';
                document.getElementById('tplMaxRightLabel').style.display = '';
                document.getElementById('tplMaxRight').parentElement.style.display = '';
            } else {
                document.getElementById('tplPillarLabel').textContent = 'No. of Pillars (LED)';
                document.getElementById('tplTrackSizeLabel').textContent = 'Track Size (m)';
                document.getElementById('tplPillarWidthLabel').textContent = isHmrsSlider ? 'LED/TV Width (m)' : 'Pillar Width (m)';
                secDimLabel.textContent = 'LED/TV Height (m)';
                secDimGroup.style.display = isHmrsSlider ? '' : 'none';
                document.getElementById('tplMaxLeftLabel').innerHTML = 'Max Distance Left (m) <span id="tplMaxLeftHint" class="tpl-avail-info"></span>';
                document.getElementById('tplMaxRightLabel').innerHTML = 'Max Distance Right (m) <span id="tplMaxRightHint" class="tpl-avail-info"></span>';
                document.getElementById('tplMaxRightLabel').style.display = '';
                document.getElementById('tplMaxRight').parentElement.style.display = '';
            }

            // Show/hide sections
            document.getElementById('tplSlaveBreakdown').style.display = (isHmrs || isMatrix) ? '' : 'none';
            // Show movement bounds for all products
            document.getElementById('tplMovementBoundsRow').style.display = '';
            tplFormChanged();
            tplUpdateAutoAccelUI();
        }

        function tplFormChanged() {
            const product = document.getElementById('tplProduct').value;
            const trackSize = parseFloat(document.getElementById('tplTrackSize').value) || 10;
            const pillarWidth = parseFloat(document.getElementById('tplPillarWidth').value) || 1;
            const pillarCount = parseInt(document.getElementById('tplPillarCount').value) || 1;
            const isHmrs = product === 'hmrs';
            const isHmrsSlider = product === 'hmrs_slider';
            const isMatrix = product.startsWith('matrix_');
            const matrixRows = isMatrix ? (parseInt(product.split('_')[1].charAt(0)) || 1) : 1;

            let totalSlaves = pillarCount;
            if (product === 'hmrs') totalSlaves = pillarCount * 2;
            else if (product === 'matrix_2row') totalSlaves = pillarCount * 2;
            else if (product === 'matrix_3row') totalSlaves = pillarCount * 3;

            const slaveInfo = document.getElementById('tplSlaveInfo');
            if (slaveInfo) slaveInfo.textContent = `Total slaves: ${totalSlaves}`;
            const oSlaveInfo = document.getElementById('overlayTplSlaveInfo');
            if (oSlaveInfo) oSlaveInfo.textContent = `Total slaves: ${totalSlaves}`;

            // Slave breakdown
            const breakdownEl = document.getElementById('tplSlaveBreakdown');
            if (isHmrs) {
                const rotSlaves = Array.from({ length: pillarCount }, (_, i) => i * 2);
                const movSlaves = Array.from({ length: pillarCount }, (_, i) => i * 2 + 1);
                breakdownEl.innerHTML = `<div class="tpl-hmrs-breakdown">
                    <div class="brk-item"><span class="brk-label">Total Slaves:</span> <strong>${totalSlaves}</strong></div>
                    <div class="brk-sep"></div>
                    <div class="brk-item"><span class="brk-label">Rotation:</span> <span class="brk-val-rot">${rotSlaves.join(', ')} (even)</span></div>
                    <div class="brk-sep"></div>
                    <div class="brk-item"><span class="brk-label">Movement:</span> <span class="brk-val-mov">${movSlaves.join(', ')} (odd)</span></div>
                </div>`;
            } else if (isMatrix) {
                const rows = matrixRows;
                let trackHtml = '';
                for (let t = 0; t < pillarCount; t++) {
                    const slaveIds = Array.from({ length: rows }, (_, r) => t * rows + r);
                    trackHtml += `<div class="brk-item"><span class="brk-label">t${t + 1}:</span> <span class="brk-val-mov">${slaveIds.join(',')}</span></div>`;
                    if (t < pillarCount - 1) trackHtml += '<div class="brk-sep"></div>';
                }
                breakdownEl.innerHTML = `<div class="tpl-hmrs-breakdown" style="flex-wrap:wrap;">
                    <div class="brk-item"><span class="brk-label">${pillarCount} track x ${rows} =</span> <strong>${totalSlaves} slaves</strong></div>
                    <div class="brk-sep"></div>
                    ${trackHtml}
                </div>`;
            }

            const fitErr = document.getElementById('tplFitError');
            const availInfo = document.getElementById('tplAvailInfo');
            const nextBtn = document.getElementById('tplNextBtn');
            if (isHmrs) {
                const maxRotEl = document.getElementById('tplMaxRotation');
                if (maxRotEl) {
                    let val = parseFloat(maxRotEl.value);
                    if (!Number.isFinite(val)) val = 0;
                    if (val < 0) val = 0;
                    if (val > 360) val = 360;
                    maxRotEl.value = val;
                }
            }

            if (isMatrix) {
                // Matrix: LEDs start at bottom (0), move upward
                // Available space = trackSize - total LED height (rows * pillarWidth)
                const totalLedHeight = matrixRows * pillarWidth;
                const availableTop = Math.floor((trackSize - totalLedHeight) * 100) / 100;
                fitErr.style.display = 'none';
                nextBtn.disabled = false;

                if (totalLedHeight > trackSize) {
                    fitErr.textContent = `LEDs don't fit! ${matrixRows} rows x ${pillarWidth}m = ${totalLedHeight}m > ${trackSize}m track.`;
                    fitErr.style.display = '';
                    nextBtn.disabled = true;
                    availInfo.textContent = '';
                } else {
                    availInfo.textContent = `Available movement: ${availableTop.toFixed(2)}m (track ${trackSize}m - LED height ${totalLedHeight}m)`;
                }

                const maxLeftEl = document.getElementById('tplMaxLeft');
                const maxRightEl = document.getElementById('tplMaxRight');
                const minTop = 0;
                maxLeftEl.max = availableTop;
                maxLeftEl.min = minTop;
                let curMax = parseFloat(maxLeftEl.value) || 0;
                if (curMax > availableTop) maxLeftEl.value = availableTop;
                if (curMax < minTop) maxLeftEl.value = minTop;
                maxRightEl.value = 0;
                document.getElementById('tplMaxLeftHint').textContent = `(min: ${minTop}, max: ${availableTop})`;
            } else if (pillarCount * pillarWidth > trackSize) {
                const maxPillarW = Math.floor((trackSize / pillarCount) * 100) / 100;
                fitErr.textContent = `Pillars don't fit! ${pillarCount} x ${pillarWidth}m = ${pillarCount * pillarWidth}m > ${trackSize}m track. Max pillar width: ${maxPillarW}m`;
                fitErr.style.display = '';
                availInfo.textContent = '';
                nextBtn.disabled = true;
                document.getElementById('tplMaxLeftHint').textContent = '';
                document.getElementById('tplMaxRightHint').textContent = '';
            } else {
                fitErr.style.display = 'none';
                nextBtn.disabled = false;

                const pillarsTotal = pillarCount * pillarWidth;
                const availableSpace = trackSize - pillarsTotal;
                const availEachSide = Math.floor((availableSpace / 2) * 100) / 100;
                availInfo.textContent = `Available space: ${availableSpace.toFixed(2)}m total (${availEachSide}m each side)`;

                const maxLeftEl = document.getElementById('tplMaxLeft');
                const maxRightEl = document.getElementById('tplMaxRight');
                const minDistEffective = 0;
                maxLeftEl.max = availEachSide;
                maxLeftEl.min = minDistEffective;
                maxRightEl.min = -availEachSide;
                maxRightEl.max = -minDistEffective;

                let leftVal = parseFloat(maxLeftEl.value) || 0;
                let rightVal = parseFloat(maxRightEl.value) || 0;
                if (leftVal > availEachSide) { maxLeftEl.value = availEachSide; }
                if (leftVal < minDistEffective && availEachSide >= minDistEffective) { maxLeftEl.value = minDistEffective; }
                if (rightVal > 0) { rightVal = -Math.abs(rightVal); maxRightEl.value = rightVal; }
                if (Math.abs(rightVal) > availEachSide) { maxRightEl.value = -availEachSide; }
                if (Math.abs(rightVal) < minDistEffective && availEachSide >= minDistEffective) { maxRightEl.value = -minDistEffective; }

                document.getElementById('tplMaxLeftHint').textContent = `(min: ${minDistEffective}, max: ${availEachSide})`;
                document.getElementById('tplMaxRightHint').textContent = `(min: -${minDistEffective}, max: -${availEachSide})`;
            }

            // Always draw preview
            drawTplLayout();
        }

        function tplGetSlaveCount() {
            const product = document.getElementById('tplProduct').value;
            const pillarCount = parseInt(document.getElementById('tplPillarCount').value) || 1;
            if (product === 'hmrs') return pillarCount * 2;
            if (product === 'matrix_2row') return pillarCount * 2;
            if (product === 'matrix_3row') return pillarCount * 3;
            return pillarCount;
        }

        function overlayTplGetSlaveCount() {
            const product = document.getElementById('overlayTplProduct').value;
            const pillarCount = parseInt(document.getElementById('overlayTplPillarCount').value) || 1;
            if (product === 'hmrs') return pillarCount * 2;
            if (product === 'matrix_2row') return pillarCount * 2;
            if (product === 'matrix_3row') return pillarCount * 3;
            return pillarCount;
        }

        function tplIsMatrixProduct(product) {
            return !!product && product.startsWith('matrix_');
        }

        function tplRotationDegToMeters(deg) {
            const d = Math.max(-360, Math.min(360, Number(deg) || 0));
            return (d * 0.015) / 45;
        }

        function tplRotationMetersToDeg(meters) {
            const m = Number(meters) || 0;
            return (m * 45) / 0.015;
        }

        function tplFormatDeg(meters) {
            const deg = tplRotationMetersToDeg(meters);
            return `${Math.round(deg * 10) / 10}°`;
        }

        function tplGetStepDisplayName(step, idx) {
            const fallback = `Step ${idx + 1}`;
            const name = step && step.name ? step.name.trim() : '';
            return name || fallback;
        }

        function tplGetGlobalSlaveDelay() {
            const el = document.getElementById('tplCfgSlaveDelay');
            const val = parseInt(el ? el.value : '');
            return Number.isFinite(val) ? val : 30;
        }

        function tplUpdateAutoAccelUI() {
            const toggle = document.getElementById('tplAutoAccelToggle');
            const autoOn = !!toggle?.checked;
            const movInputs = document.getElementById('tplAccelDecelInputs');
            const movLine = document.getElementById('tplAccelDecelLine');
            const rotInputs = document.getElementById('tplRotAccelDecelInputs');
            const rotLine = document.getElementById('tplRotAccelDecelLine');
            if (movInputs) movInputs.style.display = autoOn ? 'none' : 'grid';
            if (movLine) movLine.style.display = autoOn ? 'block' : 'none';
            if (rotInputs) rotInputs.style.display = autoOn ? 'none' : 'grid';
            if (rotLine) rotLine.style.display = autoOn ? 'block' : 'none';
            if (autoOn) tplSyncAutoAccelDecel();
        }

        function tplSyncAutoAccelDecel() {
            const velEl = document.getElementById('tplCfgVelocity');
            const accEl = document.getElementById('tplCfgAccel');
            const decEl = document.getElementById('tplCfgDecel');
            const line = document.getElementById('tplAccelDecelLine');
            const rotVelEl = document.getElementById('tplCfgRotVelocity');
            const rotAccEl = document.getElementById('tplCfgRotAccel');
            const rotDecEl = document.getElementById('tplCfgRotDecel');
            const rotLine = document.getElementById('tplRotAccelDecelLine');
            if (!velEl || !accEl || !decEl) return;
            const vel = parseInt(velEl.value) || 0;
            const half = Math.max(0, Math.round(vel / 2));
            const autoOn = !!document.getElementById('tplAutoAccelToggle')?.checked;
            if (autoOn) {
                accEl.value = half;
                decEl.value = half;
                if (line) line.textContent = `Accel-Decel = ${half}`;
            } else {
                if (line) line.textContent = `Accel-Decel = ${accEl.value || half}`;
            }

            if (rotVelEl && rotAccEl && rotDecEl) {
                const rVel = parseInt(rotVelEl.value) || 0;
                const rHalf = Math.max(0, Math.round(rVel / 2));
                if (autoOn) {
                    rotAccEl.value = rHalf;
                    rotDecEl.value = rHalf;
                    if (rotLine) rotLine.textContent = `Accel-Decel = ${rHalf}`;
                } else {
                    if (rotLine) rotLine.textContent = `Accel-Decel = ${rotAccEl.value || rHalf}`;
                }
            }
        }

        function tplGetStepSlaveDelayMs(step) {
            const product = (tplSetup && tplSetup.product) || document.getElementById('tplProduct')?.value || '';
            const isMatrix = tplIsMatrixProduct(product);
            if (!isMatrix || !step?.isIndividualStepDelay) return tplGetGlobalSlaveDelay();
            const stepDelay = parseInt(step?.slaveDelayMs);
            return Number.isFinite(stepDelay) ? stepDelay : tplGetGlobalSlaveDelay();
        }

        function tplStepAllowsMoveOrder(step) {
            if (!step) return false;
            const isHmrs = tplSetup.product === 'hmrs';
            const sType = step.stepType || 'movement';
            if (isHmrs && sType === 'rotation') return false;
            return true;
        }

        function tplMapMoveOrderForSave(moveOrderList) {
            const list = Array.isArray(moveOrderList) ? moveOrderList : [];
            if (tplSetup.product !== 'hmrs') return list;
            return list.map(i => i * 2 + 1);
        }

        function tplMapMoveOrderForEdit(moveOrderList) {
            const list = Array.isArray(moveOrderList) ? moveOrderList : [];
            if (tplSetup.product !== 'hmrs') return list;
            return list
                .filter(i => Number.isInteger(i) && i >= 0 && i % 2 === 1)
                .map(i => Math.floor((i - 1) / 2));
        }

        function tplNormalizeMoveOrder(count, orderList) {
            const list = Array.isArray(orderList) ? orderList.filter(i => Number.isInteger(i) && i >= 0 && i < count) : [];
            const used = new Set(list);
            const remaining = [];
            for (let i = 0; i < count; i++) {
                if (!used.has(i)) remaining.push(i);
            }
            return list.concat(remaining);
        }

        function tplAddMoveOrderIndex(idx) {
            if (tplActiveStep < 0) return;
            const step = tplSteps[tplActiveStep];
            if (!tplStepAllowsMoveOrder(step)) return;
            if (step.moveOrderMode !== 'define') return;
            if (!Array.isArray(step.moveOrderList)) step.moveOrderList = [];
            if (!step.moveOrderList.includes(idx)) step.moveOrderList.push(idx);
            tplRenderAllStepCards();
            drawTplStepCanvas();
        }

        function tplSnapToRuler(val, step = 0.25) {
            const v = Number(val) || 0;
            return Math.round(v / step) * step;
        }

        function tplClearPendingOrderPick() {
            tplPendingOrderPick = null;
            tplPendingOrderMoved = false;
        }

        function tplSetZoom(val) {
            const next = Math.max(0.5, Math.min(2.5, Number(val) || 1));
            tplZoom = Math.round(next * 100) / 100;
            const label = document.getElementById('tplZoomLabel');
            if (label) label.textContent = `${Math.round(tplZoom * 100)}%`;
            drawTplStepCanvas();
        }

        function tplZoomIn() {
            tplSetZoom(tplZoom + 0.1);
        }

        function tplZoomOut() {
            tplSetZoom(tplZoom - 0.1);
        }

        let tplEditingStepNameIdx = -1;

        function tplStartEditStepName(idx) {
            if (idx < 0 || !tplSteps[idx]) return;
            tplEditingStepNameIdx = idx;
            tplRenderAllStepCards();
            setTimeout(() => {
                const input = document.querySelector(`#tplStepsList .tpl-step-card[data-step-index="${idx}"] .tpl-step-name-input`);
                if (input) {
                    input.focus();
                    input.select();
                }
            }, 0);
        }

        function tplCommitEditStepName(idx, value) {
            if (idx < 0 || !tplSteps[idx]) return;
            const trimmed = (value || '').trim();
            tplSteps[idx].name = trimmed;
            tplEditingStepNameIdx = -1;
            tplRenderAllStepCards();
        }

        function tplCancelEditStepName() {
            tplEditingStepNameIdx = -1;
            tplRenderAllStepCards();
        }

        // ---- Next: open step builder fullscreen ----
        function tplNext() {
            if (tplEditorMode === 'overlay') {
                tplStepReturnTarget = 'create';
                hideInterfaceOverlay();
            }
            const name = document.getElementById('tplName').value.trim();
            if (!name) {
                const input = document.getElementById('tplName');
                const err = document.getElementById('tplNameError');
                if (input) input.classList.add('input-error');
                if (err) err.style.display = 'block';
                showToast('Template name is required', 'error');
                return;
            }

            const product = document.getElementById('tplProduct').value;
            const isHmrs = product === 'hmrs';
            const isMatrix = product.startsWith('matrix_');
            const isHmrsSlider = product === 'hmrs_slider';
            const trackSize = parseFloat(document.getElementById('tplTrackSize').value) || 10;
            const pillarWidth = parseFloat(document.getElementById('tplPillarWidth').value) || 1;
            const pillarCount = parseInt(document.getElementById('tplPillarCount').value) || 1;
            if (!isMatrix && pillarCount * pillarWidth > trackSize) {
                showToast('Pillars don\'t fit in track!');
                return;
            }
            tplSyncAutoAccelDecel();

            // Store setup for step builder
            const secondDim = (isMatrix || isHmrs || isHmrsSlider) ? (parseFloat(document.getElementById('tplSecondDim').value) || 0.5) : 0;
            tplSetup = {
                name,
                product,
                trackSize,
                pillarWidth,
                pillarCount,
                secondDim, // matrix: LED/TV width; HMRS: LED/TV height
                maxLeft: parseFloat(document.getElementById('tplMaxLeft').value) || (isMatrix ? trackSize : 1.5),
                maxRight: isMatrix ? 0 : (parseFloat(document.getElementById('tplMaxRight').value) || -1.5),
                slaveCount: tplGetSlaveCount(),
                maxRotation: isHmrs ? tplRotationDegToMeters(Math.abs(parseFloat(document.getElementById('tplMaxRotation').value) || 45)) : 0
            };

            tplSteps = [];
            tplActiveStep = -1;
            tplDragPillar = -1;

            // Show/hide rotation speed section
            document.getElementById('tplRotSpeedSection').style.display = isHmrs ? '' : 'none';
            const homeToggle = document.getElementById('tplIncludeHomeStep');
            if (homeToggle) homeToggle.checked = true;

            document.getElementById('tplStepTitle').textContent = name + ' - Steps';
            document.getElementById('tplStepOverlay').classList.add('active');
            document.getElementById('tplStepsList').innerHTML = '';
            document.getElementById('tplStepHint').textContent = isMatrix
                ? 'Click a LED on track to select, then drag up/down to move'
                : 'Click a pillar to select, then drag to move';
            tplUpdateSpeedTestUI();
            tplUpdateSpeedTestSlaveOptions();
            const panel = document.getElementById('tplSpeedTestPanel');
            if (panel) panel.style.display = 'none';
            const cfgBtn = document.getElementById('tplConfigBtn');
            if (cfgBtn) cfgBtn.style.display = (tplEditorMode === 'overlay') ? 'none' : '';

            // Init canvas events
            const c = document.getElementById('tplStepCanvas');
            c.onmousedown = tplCanvasMouseDown;
            c.onmousemove = tplCanvasMouseMove;
            c.onmouseup = tplCanvasMouseUp;
            c.onmouseleave = tplCanvasMouseUp;

            setTimeout(() => drawTplStepCanvas(), 50);
        }

        function tplShowStepBackConfirm() {
            const modal = document.getElementById('tplStepBackModal');
            if (modal) modal.classList.add('active');
        }

        function tplHideStepBackConfirm(evt) {
            if (evt && evt.target && evt.target.id !== 'tplStepBackModal') return;
            const modal = document.getElementById('tplStepBackModal');
            if (modal) modal.classList.remove('active');
        }

        function tplConfirmStepBack() {
            tplHideStepBackConfirm();
            tplStepBack(true);
        }

        function tplStepBack(skipConfirm) {
            if (!skipConfirm) {
                tplShowStepBackConfirm();
                return;
            }
            if (tplSimRunning) tplSimStop();
            tplClearPendingOrderPick();
            document.getElementById('tplStepOverlay').classList.remove('active');
            const c = document.getElementById('tplStepCanvas');
            c.onmousedown = c.onmousemove = c.onmouseup = c.onmouseleave = null;
            const panel = document.getElementById('tplSpeedTestPanel');
            if (panel) panel.style.display = 'none';

            if (tplEditorMode === 'overlay') {
                if (tplStepReturnTarget === 'list') {
                    backToOverlayTemplates();
                }
                return;
            }

            // If opened from list (editTemplate), go back to list
            if (tplEditingFile && document.getElementById('tplCreateSection').style.display === 'none') {
                document.getElementById('tplEditorList').style.display = '';
                loadTemplateList();
            }
        }

        function tplUpdateSpeedTestUI() {
            const product = (tplSetup && tplSetup.product) || document.getElementById('tplProduct')?.value || 'hmrs_slider';
            const rotBtn = document.getElementById('tplTestRotSpeedBtn');
            if (!rotBtn) return;
            rotBtn.style.display = (product === 'hmrs') ? '' : 'none';
        }

        function tplUpdateSpeedTestSlaveOptions() {
            const select = document.getElementById('tplSpeedTestSlave');
            if (!select) return;
            const prev = select.value;
            select.innerHTML = '';

            const count = numSlaves || 0;
            if (count <= 0) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = 'No slaves';
                select.appendChild(opt);
                select.disabled = true;
                return;
            }

            for (let i = 0; i < count; i++) {
                const opt = document.createElement('option');
                opt.value = String(i);
                opt.textContent = `Slave ${i + 1}`;
                if (prev === String(i)) opt.selected = true;
                select.appendChild(opt);
            }
            if (!select.value) select.value = '0';
            select.disabled = false;
        }

        function toggleTplSpeedTestPanel() {
            const panel = document.getElementById('tplSpeedTestPanel');
            if (!panel) return;
            const isOpen = panel.style.display === 'block';
            panel.style.display = isOpen ? 'none' : 'block';
            if (!isOpen) {
                tplUpdateSpeedTestUI();
                tplUpdateSpeedTestSlaveOptions();
                const result = document.getElementById('tplSpeedTestResult');
                if (result) result.textContent = 'Enter distance and run a test.';
            }
        }

        function setTplSpeedTestDisabled(disabled) {
            const moveBtn = document.getElementById('tplTestMoveSpeedBtn');
            const rotBtn = document.getElementById('tplTestRotSpeedBtn');
            const slaveSel = document.getElementById('tplSpeedTestSlave');
            const distInput = document.getElementById('tplSpeedTestDistance');
            if (moveBtn) moveBtn.disabled = disabled;
            if (rotBtn) rotBtn.disabled = disabled;
            if (slaveSel) slaveSel.disabled = disabled || (numSlaves <= 0);
            if (distInput) distInput.disabled = disabled;
        }

        function tplRunSpeedTest(mode) {
            if (tplSpeedTestRunning) return;

            const result = document.getElementById('tplSpeedTestResult');
            const slaveSel = document.getElementById('tplSpeedTestSlave');
            const distInput = document.getElementById('tplSpeedTestDistance');
            if (!result || !slaveSel || !distInput) return;

            if (numSlaves <= 0) {
                result.textContent = 'No slaves connected.';
                return;
            }

            const slaveIdx = parseInt(slaveSel.value);
            const distance = parseFloat(distInput.value);
            if (!Number.isFinite(distance) || distance === 0) {
                result.textContent = 'Enter a valid distance.';
                return;
            }
            if (!Number.isInteger(slaveIdx) || slaveIdx < 0 || slaveIdx >= numSlaves) {
                result.textContent = 'Select a valid slave.';
                return;
            }

            let velocity = 0;
            let accel = 0;
            let decel = 0;
            let cspMax = null;
            if (mode === 'rotation') {
                velocity = parseInt(document.getElementById('tplCfgRotVelocity').value) || 0;
                accel = parseInt(document.getElementById('tplCfgRotAccel').value) || 0;
                decel = parseInt(document.getElementById('tplCfgRotDecel').value) || 0;
                cspMax = parseInt(document.getElementById('tplCfgRotCspMax').value) || 0;
            } else {
                velocity = parseInt(document.getElementById('tplCfgVelocity').value) || 0;
                accel = parseInt(document.getElementById('tplCfgAccel').value) || 0;
                decel = parseInt(document.getElementById('tplCfgDecel').value) || 0;
            }

            if (velocity <= 0) {
                result.textContent = 'Velocity must be greater than 0.';
                return;
            }

            tplSpeedTestRunning = true;
            setTplSpeedTestDisabled(true);
            result.textContent = `Running ${mode === 'rotation' ? 'rotation' : 'movement'} test...`;

            sendCmd('tpl_speed_test', {
                slave_idx: slaveIdx,
                distance_m: distance,
                velocity: velocity,
                acceleration: accel || Math.max(1, Math.floor(velocity / 2)),
                deceleration: decel || Math.max(1, Math.floor(velocity / 2)),
                csp_max_step: cspMax || undefined,
                mode: mode
            });
        }

        function handleTplSpeedTestResult(resp) {
            tplSpeedTestRunning = false;
            setTplSpeedTestDisabled(false);
            const result = document.getElementById('tplSpeedTestResult');
            if (!result) return;

            if (!resp.success) {
                result.textContent = resp.message || 'Speed test failed.';
                return;
            }

            const data = resp.data && resp.data.tpl_speed_test ? resp.data.tpl_speed_test : null;
            if (!data) {
                result.textContent = resp.message || 'Speed test complete.';
                return;
            }

            const modeLabel = data.mode === 'rotation' ? 'Rotation' : 'Movement';
            const dist = (data.distance_m !== undefined) ? data.distance_m : 0;
            const elapsed = (data.elapsed_s !== undefined) ? data.elapsed_s : 0;
            const perM = (data.time_per_m !== undefined) ? data.time_per_m : 0;
            const velocity = data.velocity !== undefined ? data.velocity : '';
            const velText = velocity !== '' ? ` at ${velocity} velocity` : '';
            result.textContent = `Time Taken: ${elapsed}s to reach ${dist}m${velText}. 1m: ${perM}s.`;
        }

        // ---- Small preview canvas (form page) ----
        function drawTplLayout() {
            const canvas = document.getElementById('tplLayoutCanvas');
            const container = document.getElementById('tplLayoutPreview');
            const rect = container.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) return;
            const dpr = window.devicePixelRatio || 1;
            const W = rect.width;
            const H = Math.max(rect.height, 280);
            canvas.width = W * dpr;
            canvas.height = H * dpr;
            canvas.style.width = W + 'px';
            canvas.style.height = H + 'px';
            const ctx = canvas.getContext('2d');
            ctx.scale(dpr, dpr);

            const product = document.getElementById('tplProduct').value;
            const trackSize = parseFloat(document.getElementById('tplTrackSize').value) || 10;
            const pillarWidth = parseFloat(document.getElementById('tplPillarWidth').value) || 1;
            const pillarCount = parseInt(document.getElementById('tplPillarCount').value) || 1;
            const maxLeft = parseFloat(document.getElementById('tplMaxLeft').value) || 1.5;
            const maxRight = parseFloat(document.getElementById('tplMaxRight').value) || -1.5;

            ctx.fillStyle = '#e0e0e0';
            ctx.fillRect(0, 0, W, H);

            const pillarsTotal = pillarCount * pillarWidth;
            if (!product.startsWith('matrix_') && pillarsTotal > trackSize) {
                ctx.fillStyle = '#999';
                ctx.font = 'bold 14px Nunito, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('Pillars exceed track size', W / 2, H / 2);
                return;
            }

            const isMatrixProd = product.startsWith('matrix_');
            const matRows = isMatrixProd ? (parseInt(product.split('_')[1]) || 1) : 1;
            const posLen = isMatrixProd ? pillarCount * matRows : pillarCount;
            const positions = new Array(posLen).fill(0);
            const secondDim = parseFloat(document.getElementById('tplSecondDim').value) || 0;
            drawTrackScene(ctx, W, H, { product, trackSize, pillarWidth, pillarCount, maxLeft, maxRight, secondDim }, positions, -1);
        }

        // ---- Overlay-specific product change handler ----
        function overlayTplProductChanged() {
            const product = document.getElementById('overlayTplProduct').value;
            const isHmrs = product === 'hmrs';
            const isHmrsSlider = product === 'hmrs_slider';
            const isMatrix = product.startsWith('matrix_');
            document.getElementById('overlayTplRotationDegreeGroup').style.display = isHmrs ? '' : 'none';

            const secDimGroup = document.getElementById('overlayTplSecondDimGroup');
            const secDimLabel = document.getElementById('overlayTplSecondDimLabel');
            if (isMatrix) {
                document.getElementById('overlayTplPillarLabel').textContent = 'No. of Tracks';
                document.getElementById('overlayTplTrackSizeLabel').textContent = 'Track Length (m)';
                document.getElementById('overlayTplPillarWidthLabel').textContent = 'LED/TV Height (m)';
                secDimLabel.textContent = 'LED/TV Width (m)';
                secDimGroup.style.display = '';
                document.getElementById('overlayTplMaxLeftLabel').innerHTML = 'Max Distance Top (m) <span id="overlayTplMaxLeftHint" class="tpl-avail-info"></span>';
                document.getElementById('overlayTplMaxRightLabel').style.display = 'none';
                document.getElementById('overlayTplMaxRight').parentElement.style.display = 'none';
            } else if (isHmrs) {
                document.getElementById('overlayTplPillarLabel').textContent = 'No. of Pillars';
                document.getElementById('overlayTplTrackSizeLabel').textContent = 'Track Size (m)';
                document.getElementById('overlayTplPillarWidthLabel').textContent = 'Pillar Width (m)';
                secDimLabel.textContent = 'LED/TV Height (m)';
                secDimGroup.style.display = '';
                document.getElementById('overlayTplMaxLeftLabel').innerHTML = 'Max Distance Left (m) <span id="overlayTplMaxLeftHint" class="tpl-avail-info"></span>';
                document.getElementById('overlayTplMaxRightLabel').innerHTML = 'Max Distance Right (m) <span id="overlayTplMaxRightHint" class="tpl-avail-info"></span>';
                document.getElementById('overlayTplMaxRightLabel').style.display = '';
                document.getElementById('overlayTplMaxRight').parentElement.style.display = '';
            } else {
                document.getElementById('overlayTplPillarLabel').textContent = 'No. of Pillars (LED)';
                document.getElementById('overlayTplTrackSizeLabel').textContent = 'Track Size (m)';
                document.getElementById('overlayTplPillarWidthLabel').textContent = isHmrsSlider ? 'LED/TV Width (m)' : 'Pillar Width (m)';
                secDimLabel.textContent = 'LED/TV Height (m)';
                secDimGroup.style.display = isHmrsSlider ? '' : 'none';
                document.getElementById('overlayTplMaxLeftLabel').innerHTML = 'Max Distance Left (m) <span id="overlayTplMaxLeftHint" class="tpl-avail-info"></span>';
                document.getElementById('overlayTplMaxRightLabel').innerHTML = 'Max Distance Right (m) <span id="overlayTplMaxRightHint" class="tpl-avail-info"></span>';
                document.getElementById('overlayTplMaxRightLabel').style.display = '';
                document.getElementById('overlayTplMaxRight').parentElement.style.display = '';
            }

            document.getElementById('overlayTplSlaveBreakdown').style.display = (isHmrs || isMatrix) ? '' : 'none';
            document.getElementById('overlayTplMovementBoundsRow').style.display = '';
            overlayTplFormChanged();
            tplUpdateAutoAccelUI();
        }

        // ---- Overlay-specific form change handler ----
        function overlayTplFormChanged() {
            const product = document.getElementById('overlayTplProduct').value;
            const trackSize = parseFloat(document.getElementById('overlayTplTrackSize').value) || 10;
            const pillarWidth = parseFloat(document.getElementById('overlayTplPillarWidth').value) || 1;
            const pillarCount = parseInt(document.getElementById('overlayTplPillarCount').value) || 1;
            const isHmrs = product === 'hmrs';
            const isHmrsSlider = product === 'hmrs_slider';
            const isMatrix = product.startsWith('matrix_');
            const matrixRows = isMatrix ? (parseInt(product.split('_')[1].charAt(0)) || 1) : 1;

            let totalSlaves = pillarCount;
            if (product === 'hmrs') totalSlaves = pillarCount * 2;
            else if (product === 'matrix_2row') totalSlaves = pillarCount * 2;
            else if (product === 'matrix_3row') totalSlaves = pillarCount * 3;
            document.getElementById('overlayTplSlaveInfo').textContent = `Total slaves: ${totalSlaves}`;

            const breakdownEl = document.getElementById('overlayTplSlaveBreakdown');
            if (isHmrs) {
                const rotSlaves = Array.from({ length: pillarCount }, (_, i) => i * 2);
                const movSlaves = Array.from({ length: pillarCount }, (_, i) => i * 2 + 1);
                breakdownEl.innerHTML = `<div class="tpl-hmrs-breakdown">
                    <div class="brk-item"><span class="brk-label">Total Slaves:</span> <strong>${totalSlaves}</strong></div>
                    <div class="brk-sep"></div>
                    <div class="brk-item"><span class="brk-label">Rotation:</span> <span class="brk-val-rot">${rotSlaves.join(', ')} (even)</span></div>
                    <div class="brk-sep"></div>
                    <div class="brk-item"><span class="brk-label">Movement:</span> <span class="brk-val-mov">${movSlaves.join(', ')} (odd)</span></div>
                </div>`;
            } else if (isMatrix) {
                const rows = matrixRows;
                let trackHtml = '';
                for (let t = 0; t < pillarCount; t++) {
                    const slaveIds = Array.from({ length: rows }, (_, r) => t * rows + r);
                    trackHtml += `<div class="brk-item"><span class="brk-label">t${t + 1}:</span> <span class="brk-val-mov">${slaveIds.join(',')}</span></div>`;
                    if (t < pillarCount - 1) trackHtml += '<div class="brk-sep"></div>';
                }
                breakdownEl.innerHTML = `<div class="tpl-hmrs-breakdown" style="flex-wrap:wrap;">
                    <div class="brk-item"><span class="brk-label">${pillarCount} track x ${rows} =</span> <strong>${totalSlaves} slaves</strong></div>
                    <div class="brk-sep"></div>
                    ${trackHtml}
                </div>`;
            }

            const fitErr = document.getElementById('overlayTplFitError');
            const availInfo = document.getElementById('overlayTplAvailInfo');
            if (isMatrix) {
                const totalLedHeight = matrixRows * pillarWidth;
                const availableTop = Math.floor((trackSize - totalLedHeight) * 100) / 100;
                fitErr.style.display = 'none';
                if (totalLedHeight > trackSize) {
                    fitErr.textContent = `LEDs don't fit! ${matrixRows} rows x ${pillarWidth}m = ${totalLedHeight}m > ${trackSize}m track.`;
                    fitErr.style.display = '';
                    availInfo.textContent = '';
                } else {
                    availInfo.textContent = `Available movement: ${availableTop.toFixed(2)}m (track ${trackSize}m - LED height ${totalLedHeight}m)`;
                }
                const maxLeftEl = document.getElementById('overlayTplMaxLeft');
                const minTop = 0;
                maxLeftEl.max = availableTop;
                maxLeftEl.min = minTop;
                let curMax = parseFloat(maxLeftEl.value) || 0;
                if (curMax > availableTop) maxLeftEl.value = availableTop;
                if (curMax < minTop) maxLeftEl.value = minTop;
                document.getElementById('overlayTplMaxLeftHint').textContent = `(min: ${minTop}, max: ${availableTop})`;
            } else if (pillarCount * pillarWidth > trackSize) {
                const maxPillarW = Math.floor((trackSize / pillarCount) * 100) / 100;
                fitErr.textContent = `Pillars don't fit! ${pillarCount} x ${pillarWidth}m = ${pillarCount * pillarWidth}m > ${trackSize}m track. Max pillar width: ${maxPillarW}m`;
                fitErr.style.display = '';
                availInfo.textContent = '';
                document.getElementById('overlayTplMaxLeftHint').textContent = '';
                document.getElementById('overlayTplMaxRightHint').textContent = '';
            } else {
                fitErr.style.display = 'none';
                const pillarsTotal = pillarCount * pillarWidth;
                const availableSpace = trackSize - pillarsTotal;
                const availEachSide = Math.floor((availableSpace / 2) * 100) / 100;
                availInfo.textContent = `Available space: ${availableSpace.toFixed(2)}m total (${availEachSide}m each side)`;
                const maxLeftEl = document.getElementById('overlayTplMaxLeft');
                const maxRightEl = document.getElementById('overlayTplMaxRight');
                const minDistEffective = 0;
                maxLeftEl.max = availEachSide;
                maxLeftEl.min = minDistEffective;
                maxRightEl.min = -availEachSide;
                maxRightEl.max = -minDistEffective;
                let leftVal = parseFloat(maxLeftEl.value) || 0;
                let rightVal = parseFloat(maxRightEl.value) || 0;
                if (leftVal > availEachSide) maxLeftEl.value = availEachSide;
                if (leftVal < minDistEffective && availEachSide >= minDistEffective) maxLeftEl.value = minDistEffective;
                if (rightVal > 0) { rightVal = -Math.abs(rightVal); maxRightEl.value = rightVal; }
                if (Math.abs(rightVal) > availEachSide) maxRightEl.value = -availEachSide;
                if (Math.abs(rightVal) < minDistEffective && availEachSide >= minDistEffective) maxRightEl.value = -minDistEffective;
                document.getElementById('overlayTplMaxLeftHint').textContent = `(min: ${minDistEffective}, max: ${availEachSide})`;
                document.getElementById('overlayTplMaxRightHint').textContent = `(min: -${minDistEffective}, max: -${availEachSide})`;
            }

            drawOverlayTplLayout();
        }

        // ---- Overlay template preview canvas drawing ----
        function drawOverlayTplLayout() {
            const canvas = document.getElementById('overlayTplCanvas');
            const container = document.getElementById('overlayTplLayoutPreview');
            if (!canvas || !container) return;
            const rect = container.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) return;
            const dpr = window.devicePixelRatio || 1;
            const W = rect.width;
            const H = Math.max(rect.height, 280);
            canvas.width = W * dpr;
            canvas.height = H * dpr;
            canvas.style.width = W + 'px';
            canvas.style.height = H + 'px';
            const ctx = canvas.getContext('2d');
            ctx.scale(dpr, dpr);

            const product = document.getElementById('overlayTplProduct').value;
            const trackSize = parseFloat(document.getElementById('overlayTplTrackSize').value) || 10;
            const pillarWidth = parseFloat(document.getElementById('overlayTplPillarWidth').value) || 1;
            const pillarCount = parseInt(document.getElementById('overlayTplPillarCount').value) || 1;
            const maxLeft = parseFloat(document.getElementById('overlayTplMaxLeft').value) || 1.5;
            const maxRight = parseFloat(document.getElementById('overlayTplMaxRight').value) || -1.5;

            ctx.fillStyle = '#e0e0e0';
            ctx.fillRect(0, 0, W, H);

            const pillarsTotal = pillarCount * pillarWidth;
            if (!product.startsWith('matrix_') && pillarsTotal > trackSize) {
                ctx.fillStyle = '#999';
                ctx.font = 'bold 14px Nunito, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('Pillars exceed track size', W / 2, H / 2);
                return;
            }

            const isMatrixProd = product.startsWith('matrix_');
            const matRows = isMatrixProd ? (parseInt(product.split('_')[1]) || 1) : 1;
            const posLen = isMatrixProd ? pillarCount * matRows : pillarCount;
            const positions = new Array(posLen).fill(0);
            const secondDim = parseFloat(document.getElementById('overlayTplSecondDim').value) || 0;
            drawTrackScene(ctx, W, H, { product, trackSize, pillarWidth, pillarCount, maxLeft, maxRight, secondDim }, positions, -1);
        }

        // ---- Shared drawing function for track + pillars ----
        function drawTrackScene(ctx, W, H, cfg, positions, selectedPillarIdx) {
            const { product, trackSize, pillarWidth, pillarCount, maxLeft, maxRight } = cfg;
            const isHmrs = product === 'hmrs';
            const isHmrsSlider = product === 'hmrs_slider';
            const isMatrix = product.startsWith('matrix_');
            const zoom = cfg.zoom || 1;
            const PILLAR_HEIGHT_M = 1.5;
            const margin = 40;
            const maxDrawW = W - margin * 2;
            const trackH = 14;
            const labelSpace = 36;
            const trackY = H - labelSpace - trackH;
            const mToPixel = (maxDrawW / trackSize) * zoom;
            const trackWidthPx = trackSize * mToPixel;
            const trackLeft = W / 2 - trackWidthPx / 2;

            // Track (horizontal — skip for matrix which uses vertical tracks)
            if (!isMatrix) {
                // Ruler ticks (center = 0, left positive)
                const minVal = Math.min(maxLeft, maxRight);
                const maxVal = Math.max(maxLeft, maxRight);
                const tickStep = 0.25;

                ctx.strokeStyle = '#111';
                ctx.lineWidth = 2.4;
                ctx.setLineDash([2, 3]);
                ctx.font = '12px Nunito, sans-serif';
                ctx.fillStyle = '#111';
                ctx.textAlign = 'center';
                const centerX = W / 2;
                for (let v = minVal; v <= maxVal + 0.0001; v += tickStep) {
                    const x = centerX - v * mToPixel;
                    const tickH = 6;
                    ctx.beginPath();
                    ctx.moveTo(x, trackY - 2);
                    ctx.lineTo(x, trackY + trackH + 2 + tickH);
                    ctx.stroke();
                    const label = (Math.round(v * 100) / 100).toString();
                    ctx.fillText(label, x, trackY + trackH + 14 + tickH);
                }
                ctx.setLineDash([]);

                const pillarsTotal = pillarCount * pillarWidth * mToPixel;
                const groupLeftEdge = W / 2 - pillarsTotal / 2;
                const groupRightEdge = W / 2 + pillarsTotal / 2;
                const trackRight = trackLeft + trackWidthPx;
                const leftSegW = Math.max(0, groupLeftEdge - trackLeft);
                const midSegW = Math.max(0, groupRightEdge - groupLeftEdge);
                const rightSegW = Math.max(0, trackRight - groupRightEdge);

                // Available track = green, occupied = yellow
                ctx.fillStyle = '#7fd88b';
                if (leftSegW > 0) ctx.fillRect(trackLeft, trackY, leftSegW, trackH);
                if (rightSegW > 0) ctx.fillRect(groupRightEdge, trackY, rightSegW, trackH);
                ctx.fillStyle = '#f5d36b';
                if (midSegW > 0) ctx.fillRect(groupLeftEdge, trackY, midSegW, trackH);
                ctx.strokeStyle = '#666';
                ctx.lineWidth = 1;
                ctx.strokeRect(trackLeft, trackY, trackWidthPx, trackH);

                // Labels
                ctx.fillStyle = '#333';
                ctx.font = '11px Nunito, sans-serif';
                ctx.textAlign = 'left';
                ctx.fillText(maxLeft + '', trackLeft + 2, trackY + trackH + 14);
                ctx.textAlign = 'center';
                ctx.fillText('center', W / 2, trackY + trackH + 14);
                ctx.textAlign = 'right';
                ctx.fillText(maxRight + '', trackLeft + trackWidthPx - 2, trackY + trackH + 14);
                ctx.fillText('track', trackLeft + trackWidthPx - 2, trackY + trackH + 28);

                // Red-line max distance markers
                // Show where the outermost pillar edge reaches at max movement
                // maxLeft (positive) = movement to the left from home
                const maxLeftPx = groupLeftEdge - maxLeft * mToPixel;
                // maxRight (negative) = movement to the right from home
                const maxRightPx = groupRightEdge - maxRight * mToPixel;
                const visHeight = (isHmrs || isHmrsSlider) && cfg.secondDim ? cfg.secondDim : PILLAR_HEIGHT_M;
                const markerTop = trackY - visHeight * mToPixel - 30;
                const markerBottom = trackY + trackH;

                if (isHmrs || isHmrsSlider) {
                    ctx.strokeStyle = 'rgba(231, 76, 60, 0.35)';
                    ctx.lineWidth = 1.2;
                    ctx.setLineDash([2, 4]);
                    ctx.beginPath();
                    ctx.moveTo(groupLeftEdge, markerTop);
                    ctx.lineTo(groupLeftEdge, markerBottom);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(groupRightEdge, markerTop);
                    ctx.lineTo(groupRightEdge, markerBottom);
                    ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.fillStyle = 'rgba(231, 76, 60, 0.55)';
                    ctx.font = 'bold 7px Nunito, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'bottom';
                    ctx.fillText('0m', groupLeftEdge, markerTop - 12);
                    ctx.fillText('0m', groupRightEdge, markerTop - 12);
                }

                ctx.strokeStyle = 'rgba(231, 76, 60, 0.7)';
                ctx.lineWidth = 1.5;
                ctx.setLineDash([6, 3]);
                // Left bound line
                ctx.beginPath();
                ctx.moveTo(maxLeftPx, markerTop);
                ctx.lineTo(maxLeftPx, markerBottom);
                ctx.stroke();
                // Right bound line
                ctx.beginPath();
                ctx.moveTo(maxRightPx, markerTop);
                ctx.lineTo(maxRightPx, markerBottom);
                ctx.stroke();
                ctx.setLineDash([]);

                // Orange center markers between min (0) and max bounds
                if ((isHmrs || isHmrsSlider) && (maxLeft !== 0 || maxRight !== 0)) {
                    const midLeftPx = groupLeftEdge - (maxLeft * 0.5) * mToPixel;
                    const midRightPx = groupRightEdge - (maxRight * 0.5) * mToPixel;
                    ctx.strokeStyle = 'rgba(255, 159, 67, 0.9)';
                    ctx.lineWidth = 1.5;
                    ctx.setLineDash([4, 4]);
                    ctx.beginPath();
                    ctx.moveTo(midLeftPx, markerTop);
                    ctx.lineTo(midLeftPx, markerBottom);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(midRightPx, markerTop);
                    ctx.lineTo(midRightPx, markerBottom);
                    ctx.stroke();
                    ctx.setLineDash([]);
                }

                // Labels for bounds
                ctx.fillStyle = 'rgba(231, 76, 60, 0.8)';
                ctx.font = 'bold 8px Nunito, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.fillText(maxLeft + 'm', maxLeftPx, markerTop - 2);
                ctx.fillText(maxRight + 'm', maxRightPx, markerTop - 2);
            }
            const rows = isMatrix ? parseInt(product.split('_')[1]) || 1 : 1;
            const pWidthPx = pillarWidth * mToPixel;
            const pHeightPx = PILLAR_HEIGHT_M * mToPixel;

            let matrixCfg = null;
            if (isMatrix) {
                const availableW = W - margin * 2;
                const vTrackTop = margin + 20;
                const vTrackBottom = H - margin - 10;
                const vTrackH = vTrackBottom - vTrackTop;
                const vMToPixel = (vTrackH / trackSize) * zoom;
                const ledWMeters = cfg.secondDim || pillarWidth;
                let ledW = ledWMeters * vMToPixel;
                const maxLedW = (availableW / Math.max(pillarCount, 1)) * zoom;
                if (ledW > maxLedW) ledW = maxLedW;
                const startX = W / 2 - (pillarCount * ledW) / 2 + ledW / 2;
                const ledH = pillarWidth * vMToPixel;
                const ledTotalH = rows * ledH + (rows - 1) * 3;
                const maxDist = cfg.maxLeft || trackSize;
                matrixCfg = { availableW, vTrackTop, vTrackBottom, vTrackH, vMToPixel, ledW, startX, ledH, ledTotalH, maxDist };

                // Matrix rulers are drawn per-track in the loop below
            }

            // Pillar group at center + individual offsets from positions array
            const groupWidthPx = pillarCount * pWidthPx;
            const groupCenterX = W / 2; // center of track = position 0

            // Store pillar rects for hit testing
            const pillarRects = [];
            const circleRects = []; // HMRS rotation circles {cx, cy, r, idx}

            const selectedSet = (selectedPillarIdx instanceof Set)
                ? selectedPillarIdx
                : (Array.isArray(selectedPillarIdx) ? new Set(selectedPillarIdx) : null);

            for (let i = 0; i < pillarCount; i++) {
                // Home position: pillars grouped at center with no gap
                const homeX = groupCenterX - groupWidthPx / 2 + i * pWidthPx;
                // Offset from position value (meters). Left=positive, right=negative
                // On screen: left is negative pixels, so negate the value
                const offsetPx = -(positions[i] || 0) * mToPixel;
                const px = homeX + offsetPx;
                const isSelected = selectedSet ? selectedSet.has(i) : (i === selectedPillarIdx);

                if (isMatrix) {
                    // Matrix: vertical tracks — LEDs start at bottom (0), move upward
                    const { vTrackTop, vTrackBottom, vTrackH, vMToPixel, ledW, startX, ledH, ledTotalH, maxDist } = matrixCfg;
                    const vTrackX = startX + i * ledW;
                    const occupiedTop = vTrackBottom - ledTotalH;

                    // Per-track ruler: 0.25m ticks alongside each track
                    const rulerStep = 0.25;
                    const rulerX = vTrackX - ledW * 0.65;
                    ctx.strokeStyle = '#111';
                    ctx.lineWidth = 2.2;
                    ctx.setLineDash([2, 3]);
                    ctx.font = '11px Nunito, sans-serif';
                    ctx.fillStyle = '#111';
                    ctx.textAlign = 'right';
                    ctx.textBaseline = 'middle';
                    for (let v = 0; v <= maxDist + 0.0001; v += rulerStep) {
                        const y = vTrackBottom - ledTotalH - v * vMToPixel;
                        ctx.beginPath();
                        ctx.moveTo(rulerX - 10, y);
                        ctx.lineTo(rulerX + 10, y);
                        ctx.stroke();
                        const label = (Math.round(v * 100) / 100).toString();
                        ctx.fillText(label, rulerX - 14, y);
                    }
                    ctx.setLineDash([]);

                    // Vertical rail
                    ctx.fillStyle = '#7fd88b';
                    if (occupiedTop > vTrackTop) ctx.fillRect(vTrackX - 4, vTrackTop, 8, occupiedTop - vTrackTop);
                    ctx.fillStyle = '#f5d36b';
                    ctx.fillRect(vTrackX - 4, occupiedTop, 8, ledTotalH);
                    ctx.strokeStyle = '#666';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(vTrackX - 4, vTrackTop, 8, vTrackH);

                    // Track label at bottom
                    ctx.fillStyle = '#555';
                    ctx.font = 'bold 10px Nunito, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'top';
                    ctx.fillText('t' + (i + 1), vTrackX, vTrackBottom + 4);

                    // Scale marks: 0 at bottom, trackSize at top
                    ctx.fillStyle = '#aaa';
                    ctx.font = '8px Nunito, sans-serif';
                    ctx.textAlign = 'right';
                    ctx.textBaseline = 'middle';
                    ctx.fillText('0', vTrackX - 8, vTrackBottom);
                    ctx.fillText(trackSize + 'm', vTrackX - 8, vTrackTop);

                    // Max distance red line marker — shows where LED top edge stops
                    const maxLineY = vTrackBottom - ledTotalH - maxDist * vMToPixel;
                    const minTop = 0;
                    const minLineY = vTrackBottom - ledTotalH - minTop * vMToPixel;
                    ctx.strokeStyle = 'rgba(231, 76, 60, 0.7)';
                    ctx.lineWidth = 1.5;
                    ctx.setLineDash([6, 3]);
                    const markerHalf = Math.max(ledW * 0.5, 10);
                    ctx.beginPath();
                    ctx.moveTo(vTrackX - markerHalf, maxLineY);
                    ctx.lineTo(vTrackX + markerHalf, maxLineY);
                    ctx.stroke();
                    ctx.setLineDash([]);
                    // Orange center marker between min (0) and max
                    if (maxDist !== 0) {
                        const midLineY = vTrackBottom - ledTotalH - (maxDist * 0.5) * vMToPixel;
                        ctx.strokeStyle = 'rgba(255, 159, 67, 0.9)';
                        ctx.lineWidth = 1.5;
                        ctx.setLineDash([4, 4]);
                        ctx.beginPath();
                        ctx.moveTo(vTrackX - markerHalf, midLineY);
                        ctx.lineTo(vTrackX + markerHalf, midLineY);
                        ctx.stroke();
                        ctx.setLineDash([]);
                    }
                    if (Math.abs(minTop - maxDist) > 0.001) {
                        ctx.strokeStyle = 'rgba(231, 76, 60, 0.35)';
                        ctx.lineWidth = 1.2;
                        ctx.setLineDash([2, 4]);
                        ctx.beginPath();
                        ctx.moveTo(vTrackX - markerHalf, minLineY);
                        ctx.lineTo(vTrackX + markerHalf, minLineY);
                        ctx.stroke();
                        ctx.setLineDash([]);
                    }
                    // Max label
                    if (i === 0) {
                        ctx.fillStyle = 'rgba(231, 76, 60, 0.8)';
                        ctx.font = 'bold 8px Nunito, sans-serif';
                        ctx.textAlign = 'right';
                        ctx.textBaseline = 'bottom';
                        ctx.fillText(maxDist + 'm', vTrackX - 8, maxLineY - 2);
                        if (Math.abs(minTop - maxDist) > 0.001) {
                            ctx.fillStyle = 'rgba(231, 76, 60, 0.55)';
                            ctx.font = 'bold 7px Nunito, sans-serif';
                            ctx.textAlign = 'right';
                            ctx.textBaseline = 'bottom';
                            ctx.fillText(minTop + 'm', vTrackX - 8, minLineY - 2);
                        }
                    }

                    // LED/TV blocks — each slave has its own position, 0 at bottom, positive = upward
                    // pillarWidth = LED/TV Height in meters
                    const rowColors = ['#e74c3c', '#3498db', '#2ecc71'];
                    const rowColorsSelected = ['#ff7675', '#74b9ff', '#55efc4'];

                    for (let r = 0; r < rows; r++) {
                        const slaveIdx = i * rows + r; // index into positions array
                        const posVal = positions[slaveIdx] || 0;
                        const offsetY = posVal * vMToPixel;
                        // Each LED's home: stacked from bottom. Row 0 = topmost at home, row (rows-1) = bottommost
                        // At position 0, LEDs stack at bottom: last row at very bottom, first row above
                        const homeY = vTrackBottom - (rows - r) * ledH - (rows - 1 - r) * 3;
                        const ledY = homeY - offsetY;
                        const ledX = vTrackX - ledW / 2;
                        const isSlaveSelected = selectedSet ? selectedSet.has(slaveIdx) : (selectedPillarIdx === slaveIdx);

                        ctx.fillStyle = isSlaveSelected ? (rowColorsSelected[r] || '#55efc4') : (rowColors[r] || '#2ecc71');
                        ctx.fillRect(ledX, ledY, ledW, ledH);
                        ctx.strokeStyle = isSlaveSelected ? '#2d3436' : '#333';
                        ctx.lineWidth = isSlaveSelected ? 2.5 : 1.5;
                        ctx.strokeRect(ledX, ledY, ledW, ledH);
                        // Label inside LED
                        ctx.fillStyle = '#fff';
                        ctx.font = `bold ${Math.min(10, Math.max(7, ledH * 0.3))}px Nunito, sans-serif`;
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        const slaveLabel = rows > 1 ? `s${slaveIdx}` : `t${i + 1}`;
                        ctx.fillText(slaveLabel, ledX + ledW / 2, ledY + ledH / 2);

                        // Position value next to LED
                        if (posVal !== 0) {
                            ctx.fillStyle = isSlaveSelected ? '#2980b9' : '#555';
                            ctx.font = 'bold 8px Nunito, sans-serif';
                            ctx.textAlign = 'left';
                            ctx.textBaseline = 'middle';
                            ctx.fillText(posVal.toFixed(2) + 'm', ledX + ledW + 3, ledY + ledH / 2);
                        }

                        // Hit rect per slave LED
                        pillarRects.push({ x: ledX, y: ledY, w: ledW, h: ledH, isVertical: true, vTrackTop, vTrackH, vMToPixel, vTrackX, slaveIdx });
                    }
                } else if (isHmrs) {
                    // HMRS: use secondDim for LED/TV height if available
                    const hmrsHeight = (cfg.secondDim || PILLAR_HEIGHT_M) * mToPixel;
                    const pillarY = trackY - hmrsHeight;
                    // Movement pillar (rectangle)
                    ctx.fillStyle = isSelected ? '#ff7675' : '#e74c3c';
                    ctx.fillRect(px, pillarY, pWidthPx, hmrsHeight);
                    ctx.strokeStyle = isSelected ? '#2d3436' : '#000';
                    ctx.lineWidth = isSelected ? 2.5 : 1.5;
                    ctx.strokeRect(px, pillarY, pWidthPx, hmrsHeight);
                    // Movement label inside pillar
                    ctx.fillStyle = '#fff';
                    ctx.font = 'bold 9px Nunito, sans-serif';
                    ctx.textAlign = 'center';
                    const movVal = positions[i] || 0;
                    ctx.fillText(movVal.toFixed(2) + 'm', px + pWidthPx / 2, pillarY + hmrsHeight / 2 + 3);

                    // Rotation circle above pillar
                    const circR = Math.max(Math.min(pWidthPx * 1.35, 72), 42);
                    const circCx = px + pWidthPx / 2;
                    const circCy = pillarY - circR - 6;
                    const rotVal = (cfg.rotations && cfg.rotations[i]) || 0;
                    // Convert rotation value to angle for visual (0.015m = 45deg)
                    const maxRot = cfg.maxRotation || 0.015;
                    const maxDeg = maxRot > 0 ? tplRotationMetersToDeg(maxRot) : 360;
                    const rotDeg = tplRotationMetersToDeg(rotVal);
                    const clampedDeg = Math.max(-maxDeg, Math.min(maxDeg, rotDeg));
                    const rotAngle = clampedDeg * (Math.PI / 180);

                    ctx.save();
                    ctx.translate(circCx, circCy);
                    ctx.rotate(rotAngle);
                    // Circle body
                    ctx.beginPath();
                    ctx.arc(0, 0, circR, 0, Math.PI * 2);
                    ctx.fillStyle = '#f39c12';
                    ctx.fill();
                    ctx.strokeStyle = isSelected ? '#2d3436' : '#c87f0a';
                    ctx.lineWidth = isSelected ? 2.5 : 1.5;
                    ctx.stroke();
                    // Rotation indicator line (top)
                    ctx.beginPath();
                    ctx.moveTo(0, 0);
                    ctx.lineTo(0, -circR + 2);
                    ctx.strokeStyle = '#fff';
                    ctx.lineWidth = 2;
                    ctx.stroke();
                    // Rotation value text inside circle
                    ctx.rotate(-rotAngle); // un-rotate for text readability
                    ctx.fillStyle = '#fff';
                    ctx.font = `bold ${Math.max(circR * 0.22, 6)}px Nunito, sans-serif`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(`${Math.round(tplRotationMetersToDeg(rotVal) * 10) / 10}\u00B0`, 0, 2);
                    ctx.restore();

                    // Store circle for hit testing
                    circleRects.push({ cx: circCx, cy: circCy, r: circR, idx: i });

                    // Pillar label above circle
                    ctx.fillStyle = '#333';
                    ctx.font = 'bold 10px Nunito, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'alphabetic';
                    ctx.fillText('p' + (i + 1), circCx, circCy - circR - 4);
                    pillarRects.push({ x: px, y: pillarY, w: pWidthPx, h: hmrsHeight });
                } else {
                    const sliderHeight = (isHmrsSlider && cfg.secondDim ? cfg.secondDim : PILLAR_HEIGHT_M) * mToPixel;
                    const pillarY = trackY - sliderHeight;
                    ctx.fillStyle = isSelected ? '#ff7675' : '#e74c3c';
                    ctx.fillRect(px, pillarY, pWidthPx, sliderHeight);
                    ctx.strokeStyle = isSelected ? '#2d3436' : '#000';
                    ctx.lineWidth = isSelected ? 2.5 : 1.5;
                    ctx.strokeRect(px, pillarY, pWidthPx, sliderHeight);
                    ctx.fillStyle = '#333';
                    ctx.font = 'bold 10px Nunito, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillText('p' + (i + 1), px + pWidthPx / 2, pillarY - 6);
                    pillarRects.push({ x: px, y: pillarY, w: pWidthPx, h: sliderHeight });
                }

                // Position value label under pillar (skip for matrix — shown inline)
                if (!isMatrix && positions[i] !== undefined && positions[i] !== 0) {
                    ctx.fillStyle = isSelected ? 'var(--blue)' : '#555';
                    ctx.font = 'bold 9px Nunito, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillText(positions[i].toFixed(2) + 'm', px + pWidthPx / 2, trackY + trackH + 26);
                }
            }

            return { trackLeft, trackWidthPx, trackY, trackH, mToPixel, pillarRects, circleRects, pWidthPx, groupCenterX, groupWidthPx };
        }

        // ---- Fullscreen step canvas ----
        let tplSceneCache = null; // cached scene geometry

        function drawTplStepCanvas() {
            const canvas = document.getElementById('tplStepCanvas');
            const container = canvas.parentElement;
            const rect = container.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) return;
            const dpr = window.devicePixelRatio || 1;
            const W = rect.width;
            const H = rect.height;
            canvas.width = W * dpr;
            canvas.height = H * dpr;
            canvas.style.width = W + 'px';
            canvas.style.height = H + 'px';
            const ctx = canvas.getContext('2d');
            ctx.scale(dpr, dpr);

            ctx.fillStyle = '#e0e0e0';
            ctx.fillRect(0, 0, W, H);

            const activeStep = (tplActiveStep >= 0 && tplSteps[tplActiveStep]) ? tplSteps[tplActiveStep] : null;
            const orderStep = (tplSimRunning && tplSimStep >= 0 && tplSteps[tplSimStep]) ? tplSteps[tplSimStep] : activeStep;
            const posCount = (tplSetup.product && tplSetup.product.startsWith('matrix_')) ? tplSetup.slaveCount : tplSetup.pillarCount;
            const positions = tplSimRunning && tplSimLivePositions
                ? tplSimLivePositions
                : (activeStep ? activeStep.positions : new Array(posCount).fill(0));

            // Pass rotation data for HMRS
            const drawCfg = { ...tplSetup, zoom: tplZoom };
            if (tplSetup.product === 'hmrs') {
                if (tplSimRunning && tplSimLiveRotations) drawCfg.rotations = tplSimLiveRotations;
                else if (activeStep && activeStep.rotations) drawCfg.rotations = activeStep.rotations;
            }

            const selected = (tplSelectedPillars.length > 0) ? new Set(tplSelectedPillars) : tplDragPillar;
            tplSceneCache = drawTrackScene(ctx, W, H, drawCfg, positions, selected);

            const topRot = tplSetup.product === 'hmrs'
                ? (tplSimRunning && tplSimLiveRotations ? tplSimLiveRotations : (activeStep && activeStep.rotations ? activeStep.rotations : null))
                : null;
            drawTplTopView(positions, topRot);

            // Draw move order overlay for active step when defined
            if (orderStep && orderStep.moveOrderMode === 'define' && Array.isArray(orderStep.moveOrderList)) {
                const orderList = orderStep.moveOrderList;
                const rects = tplSceneCache && tplSceneCache.pillarRects ? tplSceneCache.pillarRects : [];
                const getRectBySlaveIdx = (idx) => {
                    for (let i = 0; i < rects.length; i++) {
                        const r = rects[i];
                        const rIdx = (r.slaveIdx !== undefined) ? r.slaveIdx : i;
                        if (rIdx === idx) return r;
                    }
                    return null;
                };
                ctx.save();
                ctx.font = 'bold 11px Nunito, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                orderList.forEach((slaveIdx, orderIdx) => {
                    const r = getRectBySlaveIdx(slaveIdx);
                    if (!r) return;
                    const cx = r.x + r.w / 2;
                    const cy = r.y + r.h / 2;
                    ctx.fillStyle = 'rgba(76, 139, 245, 0.9)';
                    ctx.beginPath();
                    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.fillStyle = '#fff';
                    ctx.fillText(String(orderIdx + 1), cx, cy + 0.5);
                });
                ctx.restore();
            }
        }

        function drawTplTopView(positions, rotations) {
            const topView = document.getElementById('tplTopView');
            const canvas = document.getElementById('tplTopViewCanvas');
            if (!topView || !canvas) return;

            if (tplIsMatrixProduct(tplSetup?.product)) {
                topView.style.display = 'none';
                return;
            }

            const hasRot = rotations && rotations.length;
            const isHmrs = tplSetup.product === 'hmrs' || hasRot;
            if (!isHmrs) {
                topView.style.display = 'none';
                return;
            }
            topView.style.display = 'block';

            const rect = topView.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) return;
            const dpr = window.devicePixelRatio || 1;
            const W = rect.width;
            const H = rect.height;
            canvas.width = W * dpr;
            canvas.height = H * dpr;
            canvas.style.width = W + 'px';
            canvas.style.height = H + 'px';
            const ctx = canvas.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            ctx.clearRect(0, 0, W, H);
            ctx.fillStyle = '#e6e6e6';
            ctx.fillRect(0, 0, W, H);

            const marginX = 24;
            const trackW = W - marginX * 2;
            const trackH = Math.max(18, H * 0.14);
            const trackY = H / 2 - trackH / 2;

            // Track bar
            ctx.fillStyle = '#5b5b5b';
            ctx.fillRect(marginX, trackY, trackW, trackH);

            const n = tplSetup.pillarCount || 1;
            const maxRot = tplSetup.maxRotation || 0.015;
            const rotVals = rotations || new Array(n).fill(0);
            const posVals = positions || new Array(n).fill(0);

            // LED block size scaled to track size (top view)
            const trackSize = Math.max(0.01, tplSetup.trackSize || 1);
            const mToPx = trackW / trackSize;
            const ledWm = Math.max(0.05, tplSetup.pillarWidth || 0.7);
            const ledW = Math.max(10, ledWm * mToPx);
            const ledH = Math.min(18, Math.max(12, trackH - 4));
            const groupW = n * ledW;
            const groupLeft = marginX + trackW / 2 - groupW / 2;
            const baseY = trackY + trackH / 2 - ledH / 2;

            // Track coloring: available (green) vs occupied (yellow)
            const leftSeg = Math.max(0, groupLeft - marginX);
            const midSeg = Math.max(0, groupW);
            const rightSeg = Math.max(0, (marginX + trackW) - (groupLeft + groupW));
            ctx.fillStyle = '#7fd88b';
            if (leftSeg > 0) ctx.fillRect(marginX, trackY, leftSeg, trackH);
            if (rightSeg > 0) ctx.fillRect(groupLeft + groupW, trackY, rightSeg, trackH);
            ctx.fillStyle = '#f5d36b';
            if (midSeg > 0) ctx.fillRect(groupLeft, trackY, midSeg, trackH);
            ctx.strokeStyle = '#333';
            ctx.lineWidth = 1;
            ctx.strokeRect(marginX, trackY, trackW, trackH);

            for (let i = 0; i < n; i++) {
                const homeX = groupLeft + i * ledW;
                const offsetPx = -(posVals[i] || 0) * mToPx;
                const x = homeX + offsetPx;
                const y = baseY;

                const rot = rotVals[i] || 0;
                const maxDeg = maxRot > 0 ? tplRotationMetersToDeg(maxRot) : 360;
                const rotDeg = tplRotationMetersToDeg(rot);
                const clampedDeg = Math.max(-maxDeg, Math.min(maxDeg, rotDeg));
                const angle = clampedDeg * (Math.PI / 180);

                ctx.save();
                ctx.translate(x + ledW / 2, y + ledH / 2);
                ctx.rotate(angle);
                ctx.fillStyle = '#ff3b30';
                ctx.fillRect(-ledW / 2, -ledH / 2, ledW, ledH);
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 2;
                ctx.strokeRect(-ledW / 2, -ledH / 2, ledW, ledH);
                ctx.restore();
            }
        }

        // ---- Canvas mouse interaction ----
        function tplCanvasMouseDown(e) {
            if (tplActiveStep < 0) return;
            if (!tplSceneCache) return;
            const rect = e.target.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;

            const step = tplSteps[tplActiveStep];
            const isHmrs = tplSetup.product === 'hmrs';
            const sType = step.stepType || 'movement';
            const allowMoveOrderPick = tplStepAllowsMoveOrder(step) && step.moveOrderMode === 'define' && !(e.shiftKey || e.ctrlKey || e.metaKey);

            // HMRS rotation step: hit test circles first
            if (isHmrs && (sType === 'rotation' || sType === 'all') && tplSceneCache.circleRects) {
                for (let i = tplSceneCache.circleRects.length - 1; i >= 0; i--) {
                    const c = tplSceneCache.circleRects[i];
                    const dist = Math.sqrt((mx - c.cx) ** 2 + (my - c.cy) ** 2);
                    if (dist <= c.r + 4) { // small tolerance
                        tplDragCircle = c.idx;
                        tplDragCircleStartAngle = Math.atan2(my - c.cy, mx - c.cx);
                        if (!step.rotations) step.rotations = new Array(tplSetup.pillarCount).fill(0);
                        tplDragCircleStartVal = step.rotations[c.idx] || 0;
                        tplDragPillar = c.idx; // highlight selected
                        e.target.classList.add('dragging');
                        drawTplStepCanvas();
                        return;
                    }
                }
            }

            // Hit test pillars/tracks (movement)
            if (!isHmrs || sType === 'movement' || sType === 'all') {
                for (let i = tplSceneCache.pillarRects.length - 1; i >= 0; i--) {
                    const r = tplSceneCache.pillarRects[i];
                    if (r.isVertical) {
                        // Matrix: hit test individual LED rects
                        if (mx >= r.x - 5 && mx <= r.x + r.w + 5 && my >= r.y && my <= r.y + r.h) {
                            const idx = r.slaveIdx !== undefined ? r.slaveIdx : i;
                            if (allowMoveOrderPick) {
                                tplPendingOrderPick = { idx, startX: mx, startY: my };
                                tplPendingOrderMoved = false;
                                tplDragPillar = idx;
                                tplDragRect = { ...r };
                                tplDragStartX = my;
                                e.target.classList.add('dragging');
                                drawTplStepCanvas();
                                return;
                            }
                            const ctrlMulti = e.ctrlKey || e.metaKey;
                            if (ctrlMulti) {
                                const pos = tplSelectedPillars.indexOf(idx);
                                const wasSelected = pos >= 0;
                                if (!wasSelected) tplSelectedPillars.push(idx);
                                tplPendingSelectToggle = {
                                    idx,
                                    startX: mx,
                                    startY: my,
                                    wasSelected,
                                    ctrlAtStart: true
                                };
                                tplPendingSelectMoved = false;
                            } else {
                                const isAlreadySelected = tplSelectedPillars.includes(idx);
                                if (!isAlreadySelected) tplSelectedPillars = [idx];
                                tplPendingSelectToggle = null;
                                tplPendingSelectMoved = false;
                            }
                            tplDragPillar = idx;
                            tplDragRect = { ...r }; // cache rect data for drag
                            tplDragStartX = my; // use Y for vertical drag
                            e.target.classList.add('dragging');
                            drawTplStepCanvas();
                            return;
                        }
                    } else if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) {
                        const idx = i;
                        if (allowMoveOrderPick) {
                            tplPendingOrderPick = { idx, startX: mx, startY: my };
                            tplPendingOrderMoved = false;
                            tplDragPillar = idx;
                            tplDragStartX = mx;
                            e.target.classList.add('dragging');
                            drawTplStepCanvas();
                            return;
                        }
                        const ctrlMulti = e.ctrlKey || e.metaKey;
                        if (ctrlMulti) {
                            const pos = tplSelectedPillars.indexOf(idx);
                            const wasSelected = pos >= 0;
                            if (!wasSelected) tplSelectedPillars.push(idx);
                            tplPendingSelectToggle = {
                                idx,
                                startX: mx,
                                startY: my,
                                wasSelected,
                                ctrlAtStart: true
                            };
                            tplPendingSelectMoved = false;
                        } else {
                            const isAlreadySelected = tplSelectedPillars.includes(idx);
                            if (!isAlreadySelected) tplSelectedPillars = [idx];
                            tplPendingSelectToggle = null;
                            tplPendingSelectMoved = false;
                        }
                        tplDragPillar = idx;
                        tplDragStartX = mx;
                        e.target.classList.add('dragging');
                        drawTplStepCanvas();
                        return;
                    }
                }
                if (!(e.ctrlKey || e.metaKey)) {
                    tplSelectedPillars = [];
                    drawTplStepCanvas();
                }
            }
        }

        function tplCanvasMouseMove(e) {
            if (tplActiveStep < 0) return;
            if (!tplSceneCache) return;

            const canvas = e.target;
            if (tplPendingOrderPick) {
                const hr = canvas.getBoundingClientRect();
                const hx = e.clientX - hr.left;
                const hy = e.clientY - hr.top;
                const dx = Math.abs(hx - tplPendingOrderPick.startX);
                const dy = Math.abs(hy - tplPendingOrderPick.startY);
                if (dx < 4 && dy < 4) {
                    return; // treat as click, don't drag yet
                }
                tplPendingOrderMoved = true;
                tplPendingOrderPick = null;
            }

            if (tplPendingSelectToggle) {
                const hr = canvas.getBoundingClientRect();
                const hx = e.clientX - hr.left;
                const hy = e.clientY - hr.top;
                const dx = Math.abs(hx - tplPendingSelectToggle.startX);
                const dy = Math.abs(hy - tplPendingSelectToggle.startY);
                if (dx < 4 && dy < 4) {
                    return; // treat as click, don't drag yet
                }
                tplPendingSelectMoved = true;
            }

            // Update hover cursor for HMRS rotation circles
            if (tplDragCircle < 0 && tplDragPillar < 0 && tplSceneCache.circleRects && tplSceneCache.circleRects.length > 0) {
                const hr = canvas.getBoundingClientRect();
                const hx = e.clientX - hr.left;
                const hy = e.clientY - hr.top;
                const step = tplSteps[tplActiveStep];
                const sType = step ? (step.stepType || 'movement') : 'movement';
                let overCircle = false;
                if (tplSetup.product === 'hmrs' && (sType === 'rotation' || sType === 'all')) {
                    for (const c of tplSceneCache.circleRects) {
                        if (Math.sqrt((hx - c.cx) ** 2 + (hy - c.cy) ** 2) <= c.r + 4) {
                            overCircle = true;
                            break;
                        }
                    }
                }
                canvas.style.cursor = overCircle ? 'grab' : '';
            }

            // HMRS rotation circle drag
            if (tplDragCircle >= 0) {
                const rect = e.target.getBoundingClientRect();
                const mx = e.clientX - rect.left;
                const my = e.clientY - rect.top;
                const circ = tplSceneCache.circleRects.find(c => c.idx === tplDragCircle);
                if (!circ) return;

                const currentAngle = Math.atan2(my - circ.cy, mx - circ.cx);
                let angleDiff = currentAngle - tplDragCircleStartAngle;
                // Normalize to -PI..PI
                if (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
                if (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

                // Map angle change to rotation value: full 2PI = 360deg
                const maxRot = tplSetup.maxRotation || 0.015;
                const fullCircleMeters = tplRotationDegToMeters(360);
                const valueDelta = (angleDiff / (Math.PI * 2)) * fullCircleMeters;
                let newVal = Math.round((tplDragCircleStartVal + valueDelta) * 1000) / 1000;

                // Clamp to -maxRotation .. +maxRotation
                newVal = Math.max(-maxRot, Math.min(maxRot, newVal));

                const step = tplSteps[tplActiveStep];
                if (!step.rotations) step.rotations = new Array(tplSetup.pillarCount).fill(0);
                step.rotations[tplDragCircle] = newVal;

                drawTplStepCanvas();
                tplUpdateStepCard(tplActiveStep);
                return;
            }

            // Movement pillar/track drag
            if (tplDragPillar < 0) return;
            const rect = e.target.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;

            const step = tplSteps[tplActiveStep];
            const snapOn = e.shiftKey;
            const isMatrix = tplSetup.product && tplSetup.product.startsWith('matrix_');
            const pillarRect = (isMatrix && tplDragRect) ? tplDragRect : tplSceneCache.pillarRects[tplDragPillar];

            if (isMatrix && pillarRect && pillarRect.isVertical) {
                const dy = my - tplDragStartX;
                const dMeters = -dy / pillarRect.vMToPixel;
                const maxMovement = tplSetup.maxLeft || tplSetup.trackSize;
                const matRows = parseInt((tplSetup.product || '').split('_')[1]) || 1;
                const selected = (tplSelectedPillars && tplSelectedPillars.length > 0) ? new Set(tplSelectedPillars) : new Set([tplDragPillar]);
                const updated = step.positions.map((v, i) => {
                    if (selected.has(i)) {
                        let nextVal = Math.round((v + dMeters) * 100) / 100;
                        nextVal = Math.max(0, Math.min(maxMovement, nextVal));
                        if (snapOn) nextVal = tplSnapToRuler(nextVal);
                        return Math.max(0, Math.min(maxMovement, nextVal));
                    }
                    return v;
                });

                if (matRows > 1) {
                    const trackCount = tplSetup.pillarCount || 1;
                    for (let t = 0; t < trackCount; t++) {
                        const start = t * matRows;
                        // Enforce row0 >= row1 >= row2
                        for (let r = 1; r < matRows; r++) {
                            if (updated[start + r] > updated[start + r - 1]) {
                                updated[start + r] = updated[start + r - 1];
                            }
                        }
                        for (let r = matRows - 2; r >= 0; r--) {
                            if (updated[start + r] < updated[start + r + 1]) {
                                updated[start + r] = updated[start + r + 1];
                            }
                        }
                    }
                }

                selected.forEach(i => {
                    step.positions[i] = updated[i];
                });
                tplDragStartX = my;
            } else {
                // Horizontal drag
                const dx = mx - tplDragStartX;
                const dMeters = -dx / tplSceneCache.mToPixel;
                const leftBound = tplSetup.maxLeft;
                const rightBound = tplSetup.maxRight;
                const minVal = Math.min(leftBound, rightBound);
                const maxVal = Math.max(leftBound, rightBound);
                const count = tplSetup.pillarCount || step.positions.length;
                const selected = (tplSelectedPillars && tplSelectedPillars.length > 0)
                    ? new Set(tplSelectedPillars)
                    : new Set([tplDragPillar]);

                let deltaMin = -Infinity;
                let deltaMax = Infinity;
                selected.forEach(i => {
                    const pos = step.positions[i];
                    deltaMin = Math.max(deltaMin, minVal - pos);
                    deltaMax = Math.min(deltaMax, maxVal - pos);
                    if (i > 0 && !selected.has(i - 1)) {
                        deltaMax = Math.min(deltaMax, step.positions[i - 1] - pos);
                    }
                    if (i < count - 1 && !selected.has(i + 1)) {
                        deltaMin = Math.max(deltaMin, step.positions[i + 1] - pos);
                    }
                });
                if (!Number.isFinite(deltaMin)) deltaMin = 0;
                if (!Number.isFinite(deltaMax)) deltaMax = 0;

                const appliedDelta = Math.max(deltaMin, Math.min(deltaMax, dMeters));
                selected.forEach(i => {
                    let newPos = Math.round((step.positions[i] + appliedDelta) * 100) / 100;
                    newPos = Math.max(minVal, Math.min(maxVal, newPos));
                    if (snapOn) newPos = tplSnapToRuler(newPos);
                    step.positions[i] = Math.max(minVal, Math.min(maxVal, newPos));
                });
                tplDragStartX = mx;
            }

            drawTplStepCanvas();
            tplUpdateStepCard(tplActiveStep);
            tplUpdateStepTimeTable();
        }

        function tplCanvasMouseUp(e) {
            if (tplDragCircle >= 0) {
                tplDragCircle = -1;
                tplDragPillar = -1;
                e.target.classList.remove('dragging');
                drawTplStepCanvas();
                tplRenderAllStepCards();
                return;
            }
            if (tplPendingSelectToggle && !tplPendingSelectMoved) {
                const { idx, wasSelected, ctrlAtStart } = tplPendingSelectToggle;
                if (ctrlAtStart && wasSelected) {
                    const pos = tplSelectedPillars.indexOf(idx);
                    if (pos >= 0) tplSelectedPillars.splice(pos, 1);
                    drawTplStepCanvas();
                }
            }
            if (tplPendingOrderPick && !tplPendingOrderMoved) {
                tplAddMoveOrderIndex(tplPendingOrderPick.idx);
                tplPendingOrderPick = null;
                tplPendingOrderMoved = false;
                tplDragPillar = -1;
                tplDragRect = null;
                e.target.classList.remove('dragging');
                return;
            }
            if (tplDragPillar >= 0) {
                e.target.classList.remove('dragging');
                tplDragPillar = -1;
                tplDragRect = null;
                drawTplStepCanvas();
                if (tplActiveStep >= 0) tplValidateStep(tplActiveStep);
            }
            tplPendingOrderPick = null;
            tplPendingOrderMoved = false;
            tplPendingSelectToggle = null;
            tplPendingSelectMoved = false;
        }

        // ---- Position validation ----
        function tplValidatePositions(positions) {
            const isMatrix = tplSetup.product && tplSetup.product.startsWith('matrix_');

            if (isMatrix) {
                const maxPos = tplSetup.maxLeft || tplSetup.trackSize || 10;
                const rows = parseInt((tplSetup.product || '').split('_')[1]) || 1;
                const trackCount = tplSetup.pillarCount;

                // Range check: all values 0 to maxPos
                for (let i = 0; i < positions.length; i++) {
                    const tIdx = Math.floor(i / rows) + 1;
                    const rIdx = (i % rows);
                    const label = rows > 1 ? `t${tIdx}s${i}` : `t${tIdx}`;
                    if (positions[i] < 0 || positions[i] > maxPos) {
                        return { valid: false, msg: `${label} value ${positions[i]} out of range [0, ${maxPos}]` };
                    }
                }

                // Per-track ordering: row 0 >= row 1 >= row 2 (first row leads)
                if (rows > 1) {
                    for (let t = 0; t < trackCount; t++) {
                        const start = t * rows;
                        for (let j = 1; j < rows; j++) {
                            if (positions[start + j] > positions[start + j - 1]) {
                                return { valid: false, msg: `t${t + 1}: s${start + j - 1} (${positions[start + j - 1]}) must be >= s${start + j} (${positions[start + j]}) — first row leads` };
                            }
                        }
                    }
                }
                return { valid: true, msg: '' };
            }

            // Non-matrix: original validation
            const left = tplSetup.maxLeft;
            const right = tplSetup.maxRight;
            const minVal = Math.min(left, right);
            const maxVal = Math.max(left, right);

            for (let i = 0; i < positions.length; i++) {
                if (positions[i] < minVal || positions[i] > maxVal) {
                    return { valid: false, msg: `p${i + 1} value ${positions[i]} out of range [${minVal}, ${maxVal}]` };
                }
            }

            if (positions.length > 1) {
                if (left > right) {
                    for (let i = 1; i < positions.length; i++) {
                        if (positions[i] > positions[i - 1]) {
                            return { valid: false, msg: `Must be non-increasing: p${i} (${positions[i - 1]}) >= p${i + 1} (${positions[i]})` };
                        }
                    }
                } else {
                    for (let i = 1; i < positions.length; i++) {
                        if (positions[i] < positions[i - 1]) {
                            return { valid: false, msg: `Must be non-decreasing: p${i} (${positions[i - 1]}) <= p${i + 1} (${positions[i]})` };
                        }
                    }
                }
            }
            return { valid: true, msg: '' };
        }

        function tplValidateStep(idx) {
            const step = tplSteps[idx];
            if (!step) return;
            const result = tplValidatePositions(step.positions);
            const card = document.querySelectorAll('#tplStepsList .tpl-step-card')[idx];
            if (!card) return;
            const msgEl = card.querySelector('.tpl-validation-msg');
            if (result.valid) {
                card.classList.remove('invalid');
                if (msgEl) msgEl.textContent = '';
            } else {
                card.classList.add('invalid');
                if (msgEl) msgEl.textContent = result.msg;
            }
        }

        // ---- Step management ----
        // For matrix multi-row, positions are per-slave; otherwise per-pillar
        function tplGetPosCount() {
            const isMatrix = tplSetup.product && tplSetup.product.startsWith('matrix_');
            return isMatrix ? tplSetup.slaveCount : tplSetup.pillarCount;
        }

        function tplAddStep() {
            tplClearPendingOrderPick();
            const n = tplGetPosCount();
            const isHmrs = tplSetup.product === 'hmrs';
            const last = tplSteps.length > 0 ? tplSteps[tplSteps.length - 1] : null;
            const lastSlaveDelay = last ? parseInt(last.slaveDelayMs) : NaN;
            const defaultSlaveDelay = Number.isFinite(lastSlaveDelay) ? lastSlaveDelay : tplGetGlobalSlaveDelay();
            const step = {
                name: `Step ${tplSteps.length + 1}`,
                positions: last ? [...last.positions] : new Array(n).fill(0),
                delay: 2,
                slaveDelayMs: defaultSlaveDelay,
                isIndividualStepDelay: false,
                moveOrderMode: 'dynamic',
                moveOrderList: [],
                saved: false,
                stepType: 'movement'
            };
            if (isHmrs) {
                if (last && last.rotations) step.rotations = [...last.rotations];
                else step.rotations = new Array(tplSetup.pillarCount).fill(0);
            }
            tplSteps.push(step);
            tplActiveStep = tplSteps.length - 1;
            tplPillarPositions = step.positions;
            tplRenderAllStepCards();
            drawTplStepCanvas();
            // Scroll to bottom
            const list = document.getElementById('tplStepsList');
            list.scrollTop = list.scrollHeight;
        }

        function tplRemoveStep(idx) {
            tplClearPendingOrderPick();
            tplSteps.splice(idx, 1);
            if (tplActiveStep >= tplSteps.length) tplActiveStep = tplSteps.length - 1;
            tplRenderAllStepCards();
            drawTplStepCanvas();
        }

        function tplMoveStep(idx, dir) {
            tplClearPendingOrderPick();
            const newIdx = idx + dir;
            if (newIdx < 0 || newIdx >= tplSteps.length) return;
            [tplSteps[idx], tplSteps[newIdx]] = [tplSteps[newIdx], tplSteps[idx]];
            if (tplActiveStep === idx) tplActiveStep = newIdx;
            else if (tplActiveStep === newIdx) tplActiveStep = idx;
            tplRenderAllStepCards();
        }

        function tplSelectStep(idx) {
            tplClearPendingOrderPick();
            tplActiveStep = idx;
            tplEditingStepNameIdx = -1;
            tplDragPillar = -1;
            tplSelectedPillars = [];
            tplRenderAllStepCards();
            drawTplStepCanvas();
        }

        function tplSaveStep(idx) {
            tplClearPendingOrderPick();
            const v = tplValidatePositions(tplSteps[idx].positions);
            if (!v.valid) {
                showToast('Fix errors before saving: ' + v.msg);
                return;
            }
            tplSteps[idx].saved = true;
            tplActiveStep = -1; // deselect — step is now read-only
            tplDragPillar = -1;
            tplSelectedPillars = [];
            tplRenderAllStepCards();
            drawTplStepCanvas();
            showToast('Step ' + (idx + 1) + ' saved');
        }

        function tplEditStep(idx) {
            tplClearPendingOrderPick();
            tplActiveStep = idx;
            tplDragPillar = -1;
            tplSelectedPillars = [];
            tplRenderAllStepCards();
            drawTplStepCanvas();
        }

        function tplCancelStep(idx) {
            tplClearPendingOrderPick();
            tplSteps[idx].positions = new Array(tplGetPosCount()).fill(0);
            if (tplSteps[idx].rotations) tplSteps[idx].rotations = new Array(tplSetup.pillarCount).fill(0);
            tplUpdateStepCard(idx);
            drawTplStepCanvas();
        }

        function tplCopyStep(idx) {
            tplClearPendingOrderPick();
            const src = tplSteps[idx];
            const copy = {
                name: src.name || `Step ${idx + 1}`,
                positions: [...src.positions],
                delay: src.delay,
                slaveDelayMs: src.slaveDelayMs,
                isIndividualStepDelay: !!src.isIndividualStepDelay,
                moveOrderMode: src.moveOrderMode || 'dynamic',
                moveOrderList: Array.isArray(src.moveOrderList) ? [...src.moveOrderList] : [],
                saved: true,
                stepType: src.stepType || 'movement'
            };
            if (src.rotations) copy.rotations = [...src.rotations];
            tplSteps.splice(idx + 1, 0, copy);
            tplActiveStep = -1;
            tplRenderAllStepCards();
            showToast('Step ' + (idx + 1) + ' copied');
        }

        // ---- Simulate ----
        let tplSimRunning = false;
        let tplSimTimer = null;
        let tplSimStep = -1; // -1 = home, then 0..n-1 = steps
        let tplSimLivePositions = null; // current movement positions during sim
        let tplSimLiveRotations = null; // current rotation values during sim (HMRS)
        let tplSimSpeedConfig = null;
        let tplSimStepTimes = [];

        async function loadTplSimSpeedConfig() {
            try {
                const resp = await fetch('/api/config');
                const cfg = await resp.json();
                tplSimSpeedConfig = cfg.template_simulation_speed_test || null;
                tplUpdateStepTimeTable();
            } catch (e) {
                tplSimSpeedConfig = null;
            }
        }

        function tplCalcMoveTimeSeconds(distance, velUnits, accelUnits, decelUnits, scaleK) {
            if (distance <= 0) return 0;
            if (!scaleK || scaleK <= 0) return 0;
            const v = Math.max(0, velUnits * scaleK);
            const a = Math.max(0, accelUnits * scaleK);
            const d = distance;
            if (v <= 0 || a <= 0) return 0;

            const tAccel = v / a;
            const dAccel = 0.5 * a * tAccel * tAccel;
            if (d >= 2 * dAccel) {
                const dCruise = d - 2 * dAccel;
                return (2 * tAccel) + (dCruise / v);
            }
            return 2 * Math.sqrt(d / a);
        }

        function tplSolveScaleK(testDist, testDur, velUnits, accelUnits, decelUnits) {
            if (testDist <= 0 || testDur <= 0 || velUnits <= 0 || accelUnits <= 0) return 0;
            let lo = 0;
            let hi = 1;
            const timeAt = (k) => tplCalcMoveTimeSeconds(testDist, velUnits, accelUnits, decelUnits, k);
            while (timeAt(hi) > testDur && hi < 1e6) {
                hi *= 2;
            }
            if (hi >= 1e6) return 0;
            for (let i = 0; i < 40; i++) {
                const mid = (lo + hi) / 2;
                const t = timeAt(mid);
                if (t > testDur) lo = mid;
                else hi = mid;
            }
            return (lo + hi) / 2;
        }

        function tplCalcSimMoveTimeMs(startPos, targetPos, startRot, targetRot, mode, slaveDelayOverride) {
            let duration = 600;
            if (!tplSimSpeedConfig) return duration;

            const isRot = mode === 'rotation';
            const cfgDist = parseFloat(isRot ? tplSimSpeedConfig.rotation_distance : tplSimSpeedConfig.movement_distance) || 0;
            const cfgDur = parseFloat(isRot ? tplSimSpeedConfig.rotation_duration : tplSimSpeedConfig.movement_duration) || 0;
            const cfgVel = parseFloat(isRot ? tplSimSpeedConfig.rotation_velocity : tplSimSpeedConfig.movement_velocity) || 0;
            const cfgAcc = parseFloat(isRot ? tplSimSpeedConfig.rotation_accel : tplSimSpeedConfig.movement_accel) || 0;
            const cfgDec = parseFloat(isRot ? tplSimSpeedConfig.rotation_decel : tplSimSpeedConfig.movement_decel) || cfgAcc || 0;

            const curVel = parseFloat(isRot ? document.getElementById('tplCfgRotVelocity').value : document.getElementById('tplCfgVelocity').value) || cfgVel || 0;
            const curAcc = parseFloat(isRot ? document.getElementById('tplCfgRotAccel').value : document.getElementById('tplCfgAccel').value) || cfgAcc || 0;
            const curDec = parseFloat(isRot ? document.getElementById('tplCfgRotDecel').value : document.getElementById('tplCfgDecel').value) || cfgDec || 0;

            const scaleK = tplSolveScaleK(cfgDist, cfgDur, cfgVel, cfgAcc, cfgDec);
            if (scaleK <= 0) return duration;

            const dists = [];
            if (isRot) {
                for (let i = 0; i < startRot.length; i++) {
                    dists.push(Math.abs((targetRot[i] || 0) - (startRot[i] || 0)));
                }
            } else {
                for (let i = 0; i < startPos.length; i++) {
                    dists.push(Math.abs((targetPos[i] || 0) - (startPos[i] || 0)));
                }
            }

            const moving = dists.filter(d => d > 0.0001);
            if (moving.length === 0) return 200;

            const isHmrs = tplSetup && tplSetup.product === 'hmrs';
            const isSimultaneous = isHmrs ? true : false;
            const slaveDelayMs = Number.isFinite(slaveDelayOverride) ? slaveDelayOverride : tplGetGlobalSlaveDelay();

            const moveTimes = moving.map(d => tplCalcMoveTimeSeconds(d, curVel, curAcc, curDec, scaleK)).filter(t => t > 0);
            if (moveTimes.length === 0) return duration;

            if (isSimultaneous) {
                duration = Math.max(120, Math.max(...moveTimes) * 1000);
            } else {
                const ordered = [...moveTimes].sort((a, b) => b - a);
                let maxFinish = 0;
                for (let i = 0; i < ordered.length; i++) {
                    const finish = ordered[i] + (i * slaveDelayMs) / 1000;
                    if (finish > maxFinish) maxFinish = finish;
                }
                duration = Math.max(120, maxFinish * 1000);
            }
            return duration;
        }

        function tplGetSimMoveParams(isRot) {
            if (!tplSimSpeedConfig) return null;
            const cfgDist = parseFloat(isRot ? tplSimSpeedConfig.rotation_distance : tplSimSpeedConfig.movement_distance) || 0;
            const cfgDur = parseFloat(isRot ? tplSimSpeedConfig.rotation_duration : tplSimSpeedConfig.movement_duration) || 0;
            const cfgVel = parseFloat(isRot ? tplSimSpeedConfig.rotation_velocity : tplSimSpeedConfig.movement_velocity) || 0;
            const cfgAcc = parseFloat(isRot ? tplSimSpeedConfig.rotation_accel : tplSimSpeedConfig.movement_accel) || 0;
            const cfgDec = parseFloat(isRot ? tplSimSpeedConfig.rotation_decel : tplSimSpeedConfig.movement_decel) || 0;
            if (cfgDist <= 0 || cfgDur <= 0 || cfgVel <= 0 || cfgAcc <= 0) return null;

            const curVel = parseFloat(isRot ? document.getElementById('tplCfgRotVelocity').value : document.getElementById('tplCfgVelocity').value) || cfgVel || 0;
            const curAcc = parseFloat(isRot ? document.getElementById('tplCfgRotAccel').value : document.getElementById('tplCfgAccel').value) || cfgAcc || 0;
            const curDec = parseFloat(isRot ? document.getElementById('tplCfgRotDecel').value : document.getElementById('tplCfgDecel').value) || cfgDec || 0;

            const scaleK = tplSolveScaleK(cfgDist, cfgDur, cfgVel, cfgAcc, cfgDec);
            if (scaleK <= 0) return null;
            return { curVel, curAcc, curDec, scaleK };
        }

        function tplCalcSimStaggerProfile(startPos, targetPos, slaveDelayMs, orderList) {
            const count = Math.max(startPos.length, targetPos.length);
            const normalizedOrder = tplNormalizeMoveOrder(count, orderList);
            const params = tplGetSimMoveParams(false);
            const perSlaveMs = [];
            const offsetsMs = [];
            for (let i = 0; i < count; i++) {
                const s = startPos[i] || 0;
                const t = targetPos[i] || 0;
                const dist = Math.abs(t - s);
                let durMs = 0;
                if (params) {
                    durMs = tplCalcMoveTimeSeconds(dist, params.curVel, params.curAcc, params.curDec, params.scaleK) * 1000;
                } else {
                    durMs = dist > 0 ? 600 : 0;
                }
                perSlaveMs.push(durMs);
                offsetsMs.push(0);
            }
            normalizedOrder.forEach((slaveIdx, orderIdx) => {
                offsetsMs[slaveIdx] = orderIdx * slaveDelayMs;
            });
            let totalMs = 120;
            for (let i = 0; i < count; i++) {
                const end = offsetsMs[i] + perSlaveMs[i];
                if (end > totalMs) totalMs = end;
            }
            return { perSlaveMs, offsetsMs, totalMs };
        }

        function tplUpdateStepTimeTable() {
            const body = document.getElementById('tplStepTimeTableBody');
            if (!body) return;

            if (!tplSteps || tplSteps.length === 0) {
                body.innerHTML = '<tr><td colspan="5">No steps</td></tr>';
                return;
            }

            const isHmrs = tplSetup && tplSetup.product === 'hmrs';
            const simPosCount = (tplSetup && tplSetup.product && tplSetup.product.startsWith('matrix_')) ? tplSetup.slaveCount : (tplSetup ? tplSetup.pillarCount : 0);
            let prevPos = new Array(simPosCount).fill(0);
            let prevRot = new Array(tplSetup ? tplSetup.pillarCount : 0).fill(0);

            let html = '';
            tplSteps.forEach((step, idx) => {
                const sType = step.stepType || 'movement';
                const mode = (isHmrs && sType === 'rotation') ? 'rotation' : 'movement';
                const targetPos = (mode === 'movement') ? (step.positions || prevPos) : prevPos;
                const targetRot = (mode === 'rotation') ? (step.rotations || prevRot) : prevRot;

                const durationMs = (tplSimStepTimes[idx] && tplSimStepTimes[idx].durationMs)
                    ? tplSimStepTimes[idx].durationMs
                    : tplCalcSimMoveTimeMs(prevPos, targetPos, prevRot, targetRot, mode, tplGetStepSlaveDelayMs(step));
                const delayMs = (step.delay || 0) * 1000;
                const totalMs = durationMs + delayMs;

                const stepName = (step.name && step.name.trim()) ? step.name.trim() : `Step ${idx + 1}`;
                html += `<tr>
                    <td>${idx + 1}</td>
                    <td>${stepName}</td>
                    <td>${mode === 'rotation' ? 'Rotation' : 'Move'}</td>
                    <td>${(durationMs / 1000).toFixed(2)}s</td>
                    <td>${(delayMs / 1000).toFixed(2)}s</td>
                    <td>${(totalMs / 1000).toFixed(2)}s</td>
                </tr>`;

                prevPos = [...targetPos];
                prevRot = [...targetRot];
            });

            body.innerHTML = html;
        }

        async function tplSimulate() {
            if (tplSimRunning) {
                tplSimStop();
                return;
            }
            if (tplSteps.length === 0) {
                showToast('Add steps first');
                return;
            }
            // Validate all
            for (let i = 0; i < tplSteps.length; i++) {
                const v = tplValidatePositions(tplSteps[i].positions);
                if (!v.valid) {
                    showToast('Step ' + (i + 1) + ' has errors');
                    return;
                }
            }
            tplSimRunning = true;
            tplActiveStep = -1;
            tplDragPillar = -1;
            const simPosCount = (tplSetup.product && tplSetup.product.startsWith('matrix_')) ? tplSetup.slaveCount : tplSetup.pillarCount;
            tplSimLivePositions = new Array(simPosCount).fill(0);
            tplSimLiveRotations = new Array(tplSetup.pillarCount).fill(0);
            tplSimStepTimes = new Array(tplSteps.length).fill(null);
            const btn = document.getElementById('tplSimBtn');
            btn.textContent = 'Stop';
            btn.classList.add('running');
            document.getElementById('tplStepHint').textContent = 'Simulating...';
            await loadTplSimSpeedConfig();
            tplSimStep = -1; // start from home
            tplSimAdvance();
        }

        function tplSimStop() {
            tplSimRunning = false;
            if (tplSimTimer) { clearTimeout(tplSimTimer); tplSimTimer = null; }
            const btn = document.getElementById('tplSimBtn');
            btn.textContent = 'Simulate';
            btn.classList.remove('running');
            document.getElementById('tplStepHint').textContent = 'Click a pillar to select, then drag to move';
            // Highlight nothing
            document.querySelectorAll('#tplStepsList .tpl-step-card').forEach(c => c.classList.remove('active'));
            tplSimStep = -1;
            drawTplStepCanvas();
            tplUpdateStepTimeTable();
        }

        function tplSimAdvance() {
            if (!tplSimRunning) return;
            tplSimStep++;
            if (tplSimStep >= tplSteps.length) {
                // Loop back to home then stop
                const simPc = (tplSetup.product && tplSetup.product.startsWith('matrix_')) ? tplSetup.slaveCount : tplSetup.pillarCount;
                const zeros = new Array(simPc).fill(0);
                const rotZeros = new Array(tplSetup.pillarCount).fill(0);
                tplSimAnimateTo(zeros, rotZeros, () => {
                    tplSimStop();
                    showToast('Simulation complete');
                }, 'movement', undefined, { enabled: tplSetup.product !== 'hmrs', slaveDelayMs: tplGetGlobalSlaveDelay() });
                document.querySelectorAll('#tplStepsList .tpl-step-card').forEach(c => c.classList.remove('active'));
                return;
            }
            // Highlight current step card
            const cards = document.querySelectorAll('#tplStepsList .tpl-step-card');
            cards.forEach((c, i) => c.classList.toggle('active', i === tplSimStep));
            if (cards[tplSimStep]) cards[tplSimStep].scrollIntoView({ behavior: 'smooth', block: 'nearest' });

            const step = tplSteps[tplSimStep];
            const isHmrs = tplSetup.product === 'hmrs';
            const sType = step.stepType || 'movement';
            const stepSlaveDelayMs = tplGetStepSlaveDelayMs(step);
            const staggerCfg = {
                enabled: !isHmrs,
                slaveDelayMs: stepSlaveDelayMs,
                orderList: (step.moveOrderMode === 'define' && Array.isArray(step.moveOrderList)) ? step.moveOrderList : null
            };

            if (isHmrs && sType === 'rotation') {
                // Rotation step: keep positions, animate rotations
                const targetRot = step.rotations || new Array(tplSetup.pillarCount).fill(0);
                const durationMs = tplCalcSimMoveTimeMs(tplSimLivePositions, tplSimLivePositions, tplSimLiveRotations, targetRot, 'rotation', stepSlaveDelayMs);
                tplSimStepTimes[tplSimStep] = { durationMs };
                tplUpdateStepTimeTable();
                tplSimAnimateTo(tplSimLivePositions, targetRot, () => {
                    tplSimTimer = setTimeout(() => tplSimAdvance(), (step.delay || 1) * 1000);
                }, 'rotation', durationMs);
            } else if (isHmrs && sType === 'all') {
                const targetRot = step.rotations || new Array(tplSetup.pillarCount).fill(0);
                const moveMs = tplCalcSimMoveTimeMs(tplSimLivePositions, step.positions, tplSimLiveRotations, tplSimLiveRotations, 'movement', stepSlaveDelayMs);
                const rotMs = tplCalcSimMoveTimeMs(tplSimLivePositions, tplSimLivePositions, tplSimLiveRotations, targetRot, 'rotation', stepSlaveDelayMs);
                const durationMs = Math.max(moveMs, rotMs);
                tplSimStepTimes[tplSimStep] = { durationMs };
                tplUpdateStepTimeTable();
                tplSimAnimateTo(step.positions, targetRot, () => {
                    tplSimTimer = setTimeout(() => tplSimAdvance(), (step.delay || 1) * 1000);
                }, 'all', durationMs);
            } else {
                // Movement step: keep rotations, animate positions
                const durationMs = tplCalcSimMoveTimeMs(tplSimLivePositions, step.positions, tplSimLiveRotations, tplSimLiveRotations, 'movement', stepSlaveDelayMs);
                tplSimStepTimes[tplSimStep] = { durationMs };
                tplUpdateStepTimeTable();
                tplSimAnimateTo(step.positions, tplSimLiveRotations, () => {
                    tplSimTimer = setTimeout(() => tplSimAdvance(), (step.delay || 1) * 1000);
                }, 'movement', durationMs, staggerCfg);
            }
        }

        function tplSimAnimateTo(targetPositions, targetRotations, onDone, mode, durationOverride, staggerCfg) {
            const startPos = [...tplSimLivePositions];
            const startRot = [...tplSimLiveRotations];
            const useStagger = mode === 'movement' && staggerCfg?.enabled && Array.isArray(targetPositions) && targetPositions.length > 1;
            const staggerProfile = useStagger ? tplCalcSimStaggerProfile(startPos, targetPositions, Math.max(0, staggerCfg.slaveDelayMs || 0), staggerCfg.orderList) : null;
            const duration = Number.isFinite(durationOverride)
                ? durationOverride
                : (useStagger ? staggerProfile.totalMs : tplCalcSimMoveTimeMs(startPos, targetPositions, startRot, targetRotations, mode));
            const startTime = performance.now();

            function frame(now) {
                if (!tplSimRunning) return;
                const elapsedMs = now - startTime;
                const t = Math.min(elapsedMs / duration, 1);
                const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
                let interpPos;
                if (useStagger && staggerProfile) {
                    interpPos = startPos.map((s, i) => {
                        const target = targetPositions[i] ?? s;
                        const durMs = staggerProfile.perSlaveMs[i] || 0;
                        const offsetMs = staggerProfile.offsetsMs[i] || 0;
                        if (durMs <= 0) return target;
                        if (elapsedMs <= offsetMs) return s;
                        if (elapsedMs >= offsetMs + durMs) return target;
                        const localT = (elapsedMs - offsetMs) / durMs;
                        const localEase = localT < 0.5 ? 2 * localT * localT : -1 + (4 - 2 * localT) * localT;
                        return s + (target - s) * localEase;
                    });
                } else {
                    interpPos = startPos.map((s, i) => s + (targetPositions[i] - s) * ease);
                }
                const interpRot = startRot.map((s, i) => s + (targetRotations[i] - s) * ease);
                tplSimLivePositions = interpPos;
                tplSimLiveRotations = interpRot;
                tplSimDrawPositions(interpPos, interpRot);
                if (t < 1) {
                    requestAnimationFrame(frame);
                } else {
                    tplSimLivePositions = [...targetPositions];
                    tplSimLiveRotations = [...targetRotations];
                    tplSimDrawPositions(targetPositions, targetRotations);
                    if (onDone) onDone();
                }
            }
            requestAnimationFrame(frame);
        }

        function tplSimDrawPositions(positions, rotations) {
            const canvas = document.getElementById('tplStepCanvas');
            const container = canvas.parentElement;
            const rect = container.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) return;
            const dpr = window.devicePixelRatio || 1;
            const W = rect.width;
            const H = rect.height;
            canvas.width = W * dpr;
            canvas.height = H * dpr;
            canvas.style.width = W + 'px';
            canvas.style.height = H + 'px';
            const ctx = canvas.getContext('2d');
            ctx.scale(dpr, dpr);
            ctx.fillStyle = '#e0e0e0';
            ctx.fillRect(0, 0, W, H);
            const drawCfg = { ...tplSetup };
            if (rotations) drawCfg.rotations = rotations;
            drawTrackScene(ctx, W, H, drawCfg, positions, -1);
            drawTplTopView(positions, rotations);
        }

        // ---- Render step cards ----
        function tplRenderAllStepCards() {
            const list = document.getElementById('tplStepsList');
            let html = '';
            const includeHome = !!document.getElementById('tplIncludeHomeStep')?.checked;
            const showIndividualDelay = tplIsMatrixProduct(tplSetup?.product);
            const globalSlaveDelay = tplGetGlobalSlaveDelay();
            if (includeHome) {
                html += `<div class="tpl-step-card saved">
                    <div class="tpl-step-card-head">
                        <span class="step-num">Home All</span>
                    </div>
                    <div style="font-size:0.78rem;font-weight:600;color:var(--text);margin-top:4px;">Move all to 0m</div>
                    <div class="tpl-step-delay">
                        <span>Delay:</span>
                        <input type="number" step="0.5" min="0" value="${tplHomeStepDelay}" onchange="tplHomeStepDelay=parseFloat(this.value)||0;" onclick="event.stopPropagation()"> sec
                    </div>
                </div>`;
            }
            tplSteps.forEach((step, idx) => {
                const isActive = idx === tplActiveStep;
                const validation = tplValidatePositions(step.positions);
                const invalidClass = !validation.valid ? ' invalid' : '';

                const isHmrs = tplSetup.product === 'hmrs';
                const sType = step.stepType || 'movement';
                const stepSlaveDelay = Number.isFinite(parseInt(step.slaveDelayMs)) ? parseInt(step.slaveDelayMs) : globalSlaveDelay;
                if (showIndividualDelay && !Number.isFinite(parseInt(step.slaveDelayMs))) {
                    step.slaveDelayMs = stepSlaveDelay;
                }
                const moveOrderMode = step.moveOrderMode || 'dynamic';
                const moveOrderList = Array.isArray(step.moveOrderList) ? step.moveOrderList : [];
                const canMoveOrder = tplStepAllowsMoveOrder(step);
                const orderLabel = moveOrderList.length > 0 ? moveOrderList.map(i => i + 1).join(' \u2192 ') : '--';

                if (isActive) {
                    // ---- Editable (active) card ----
                    const typeSelector = isHmrs ? `<div class="tpl-step-type-row">
                        <label>Step Type:</label>
                        <select onchange="tplStepTypeChange(${idx},this.value)" onclick="event.stopPropagation()">
                            <option value="movement"${sType === 'movement' ? ' selected' : ''}>Movement</option>
                            <option value="rotation"${sType === 'rotation' ? ' selected' : ''}>Rotation</option>
                            <option value="all"${sType === 'all' ? ' selected' : ''}>Movement + Rotation</option>
                        </select>
                    </div>` : '';

                    // For HMRS rotation steps, show rotation inputs; otherwise movement positions
                    let posChips = '';
                    if (isHmrs && (sType === 'rotation' || sType === 'all')) {
                        const rots = step.rotations || new Array(tplSetup.pillarCount).fill(0);
                        const maxRotMeters = tplSetup.maxRotation || tplRotationDegToMeters(360);
                        const maxRotDeg = Math.max(0, Math.round(Math.abs(tplRotationMetersToDeg(maxRotMeters)) * 10) / 10);
                        const rotChips = rots.map((v, pi) => `<span class="tpl-step-pos-chip" style="border-color:#f39c12;">
                            <span class="chip-label" style="color:#f39c12;">rot${pi + 1}:</span>
                            <input type="number" step="1" min="${-maxRotDeg}" max="${maxRotDeg}" value="${Math.round(tplRotationMetersToDeg(v) * 10) / 10}" onchange="tplStepRotInput(${idx},${pi},this)" onclick="event.stopPropagation()">°
                        </span>`).join('');
                        if (sType === 'all') {
                            const movChips = step.positions.map((v, pi) => `<span class="tpl-step-pos-chip${!validation.valid ? ' invalid' : ''}">
                                <span class="chip-label">p${pi + 1}s${pi * 2 + 1}:</span>
                                <input type="number" step="0.01" value="${v}" onchange="tplStepPosInput(${idx},${pi},this)" onclick="event.stopPropagation()">
                            </span>`).join('');
                            posChips = `<div style="margin-bottom:6px;font-weight:700;color:#f39c12;font-size:0.75rem;">Rotation</div>${rotChips}
                                <div style="margin:6px 0 4px;font-weight:700;color:#e74c3c;font-size:0.75rem;">Movement</div>${movChips}`;
                        } else {
                            posChips = rotChips;
                        }
                    } else {
                        const isMatrixProduct = tplSetup.product && tplSetup.product.startsWith('matrix_');
                        const matRows = isMatrixProduct ? (parseInt(tplSetup.product.split('_')[1]) || 1) : 1;
                        if (isMatrixProduct && matRows > 1) {
                            // Group chips by track for multi-row matrix
                            for (let t = 0; t < tplSetup.pillarCount; t++) {
                                posChips += `<div style="display:flex;align-items:center;gap:2px;margin-bottom:2px;"><span style="font-size:0.7rem;font-weight:700;color:#555;min-width:22px;">t${t + 1}:</span>`;
                                for (let r = 0; r < matRows; r++) {
                                    const si = t * matRows + r;
                                    const v = step.positions[si] || 0;
                                    posChips += `<span class="tpl-step-pos-chip${!validation.valid ? ' invalid' : ''}" style="margin:0 1px;">
                                        <span class="chip-label">s${si}:</span>
                                        <input type="number" step="0.01" min="0" value="${v}" onchange="tplStepPosInput(${idx},${si},this)" onclick="event.stopPropagation()">
                                    </span>`;
                                }
                                posChips += `</div>`;
                            }
                        } else if (isMatrixProduct) {
                            posChips = step.positions.map((v, pi) => `<span class="tpl-step-pos-chip${!validation.valid ? ' invalid' : ''}">
                                <span class="chip-label">t${pi + 1}:</span>
                                <input type="number" step="0.01" min="0" value="${v}" onchange="tplStepPosInput(${idx},${pi},this)" onclick="event.stopPropagation()">
                            </span>`).join('');
                        } else {
                            posChips = step.positions.map((v, pi) => `<span class="tpl-step-pos-chip${!validation.valid ? ' invalid' : ''}">
                                <span class="chip-label">p${pi + 1}s${isHmrs ? (pi * 2 + 1) : pi}:</span>
                                <input type="number" step="0.01" value="${v}" onchange="tplStepPosInput(${idx},${pi},this)" onclick="event.stopPropagation()">
                            </span>`).join('');
                        }
                    }

                    html += `<div class="tpl-step-card active${invalidClass}" onclick="tplSelectStep(${idx})" data-step-index="${idx}">
                        <div class="tpl-step-card-head">
                            ${tplEditingStepNameIdx === idx
                                ? `<input class="tpl-step-name-input" value="${tplGetStepDisplayName(step, idx)}" onblur="tplCommitEditStepName(${idx}, this.value)" onkeydown="if(event.key==='Enter'){tplCommitEditStepName(${idx}, this.value);} if(event.key==='Escape'){tplCancelEditStepName();}" />`
                                : `<span class="step-num" ondblclick="event.stopPropagation();tplStartEditStepName(${idx})">${tplGetStepDisplayName(step, idx)} (editing)</span>`
                            }
                            <div class="tpl-step-card-actions">
                                <button onclick="event.stopPropagation();tplMoveStep(${idx},-1)" title="Move up">&uarr;</button>
                                <button onclick="event.stopPropagation();tplMoveStep(${idx},1)" title="Move down">&darr;</button>
                                <button onclick="event.stopPropagation();tplRemoveStep(${idx})" title="Delete" style="color:var(--red);">&times;</button>
                            </div>
                        </div>
                        ${typeSelector}
                        <div class="tpl-step-positions">
                            ${posChips}
                        </div>
                        <div class="tpl-step-delay">
                            <span>Delay:</span>
                            <input type="number" step="0.5" min="0" value="${step.delay}" onchange="tplSteps[${idx}].delay=parseFloat(this.value)||0; tplUpdateStepTimeTable();" onclick="event.stopPropagation()"> sec
                        </div>
                        ${canMoveOrder ? `<div class="tpl-step-move-order">
                            <span>Move Order:</span>
                            <select onchange="tplSteps[${idx}].moveOrderMode=this.value; if(this.value==='dynamic'){tplSteps[${idx}].moveOrderList=[];} tplRenderAllStepCards(); drawTplStepCanvas();" onclick="event.stopPropagation()">
                                <option value="dynamic"${moveOrderMode === 'dynamic' ? ' selected' : ''}>Dynamic</option>
                                <option value="define"${moveOrderMode === 'define' ? ' selected' : ''}>Define</option>
                            </select>
                            ${moveOrderMode === 'define' ? `<span style="font-size:0.7rem;color:var(--text-light);">Click slaves in order</span>` : ''}
                            ${moveOrderMode === 'define' ? `<span style="font-size:0.7rem;color:var(--text-light);">Order: ${orderLabel}</span>` : ''}
                            ${moveOrderMode === 'define' ? `<button class="tpl-order-clear" onclick="event.stopPropagation();tplSteps[${idx}].moveOrderList=[]; tplRenderAllStepCards(); drawTplStepCanvas();">Clear</button>` : ''}
                        </div>` : ''}
                        ${showIndividualDelay ? `<div class="tpl-step-slave-delay">
                            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                                <input type="checkbox" ${step.isIndividualStepDelay ? 'checked' : ''} onchange="tplSteps[${idx}].isIndividualStepDelay=this.checked; if(this.checked && !Number.isFinite(parseInt(tplSteps[${idx}].slaveDelayMs))) tplSteps[${idx}].slaveDelayMs=${globalSlaveDelay}; tplRenderAllStepCards(); tplUpdateStepTimeTable();" onclick="event.stopPropagation()">
                                <span>Individual Slave Delay</span>
                            </label>
                            <input type="number" step="1" min="0" value="${step.isIndividualStepDelay ? stepSlaveDelay : globalSlaveDelay}" ${step.isIndividualStepDelay ? '' : 'disabled'} onchange="tplSteps[${idx}].slaveDelayMs=parseInt(this.value)||0; tplUpdateStepTimeTable();" onclick="event.stopPropagation()"> ms
                        </div>` : ''}
                        <div class="tpl-validation-msg">${!validation.valid ? validation.msg : ''}</div>
                        <div class="tpl-step-save-row">
                            <button class="btn-save-step" onclick="event.stopPropagation();tplSaveStep(${idx})">Save Step</button>
                            <button class="btn-cancel-step" onclick="event.stopPropagation();tplCancelStep(${idx})">Reset</button>
                        </div>
                    </div>`;
                } else {
                // ---- Saved / read-only card ----
                let posStr = '';
                if (isHmrs && sType === 'rotation') {
                    const rots = step.rotations || new Array(tplSetup.pillarCount).fill(0);
                    posStr = rots.map((v, pi) => `rot${pi + 1}: ${tplFormatDeg(v)}`).join(', ');
                } else if (isHmrs && sType === 'all') {
                    const rots = step.rotations || new Array(tplSetup.pillarCount).fill(0);
                    const rotStr = rots.map((v, pi) => `rot${pi + 1}: ${tplFormatDeg(v)}`).join(', ');
                    const movStr = step.positions.map((v, pi) => `p${pi + 1}: ${v}`).join(', ');
                    posStr = `move(${movStr}) | rot(${rotStr})`;
                } else {
                    const isMatrixProduct = tplSetup.product && tplSetup.product.startsWith('matrix_');
                    const matR = isMatrixProduct ? (parseInt(tplSetup.product.split('_')[1]) || 1) : 1;
                    if (isMatrixProduct && matR > 1) {
                        const parts = [];
                        for (let t = 0; t < tplSetup.pillarCount; t++) {
                            const vals = [];
                            for (let r = 0; r < matR; r++) vals.push(step.positions[t * matR + r] || 0);
                            parts.push(`t${t + 1}:[${vals.join(',')}]`);
                        }
                        posStr = parts.join(' ');
                    } else {
                        const prefix = isMatrixProduct ? 't' : 'p';
                        posStr = step.positions.map((v, pi) => `${prefix}${pi + 1}: ${v}`).join(', ');
                    }
                    }
                const typeLabel = isHmrs ? `<span style="font-size:0.7rem;padding:2px 6px;border-radius:6px;background:${sType === 'rotation' ? '#fff3e0;color:#f39c12' : sType === 'all' ? '#e8f7ff;color:#2980b9' : '#ffeaea;color:#e74c3c'};font-weight:700;margin-left:6px;">${sType}</span>` : '';
                    html += `<div class="tpl-step-card${step.saved ? ' saved' : ''}${invalidClass}" data-step-index="${idx}">
                        <div class="tpl-step-card-head">
                            ${tplEditingStepNameIdx === idx
                                ? `<input class="tpl-step-name-input" value="${tplGetStepDisplayName(step, idx)}" onblur="tplCommitEditStepName(${idx}, this.value)" onkeydown="if(event.key==='Enter'){tplCommitEditStepName(${idx}, this.value);} if(event.key==='Escape'){tplCancelEditStepName();}" />`
                                : `<span class="step-num" ondblclick="event.stopPropagation();tplStartEditStepName(${idx})">${tplGetStepDisplayName(step, idx)}${typeLabel}</span>`
                            }
                            <div class="tpl-step-card-actions">
                                <button onclick="event.stopPropagation();tplEditStep(${idx})" title="Edit" style="color:var(--blue);font-weight:800;">Edit</button>
                                <button onclick="event.stopPropagation();tplCopyStep(${idx})" title="Copy" style="color:var(--teal);font-weight:800;">Copy</button>
                                <button onclick="event.stopPropagation();tplMoveStep(${idx},-1)" title="Move up">&uarr;</button>
                                <button onclick="event.stopPropagation();tplMoveStep(${idx},1)" title="Move down">&darr;</button>
                                <button onclick="event.stopPropagation();tplRemoveStep(${idx})" title="Delete" style="color:var(--red);">&times;</button>
                            </div>
                        </div>
                        <div style="font-size:0.78rem;font-weight:600;color:var(--text);margin-top:4px;word-break:break-all;">${posStr}</div>
                        <div style="font-size:0.72rem;color:var(--text-light);margin-top:3px;">Delay: ${step.delay}s</div>
                        ${canMoveOrder && moveOrderMode === 'define' ? `<div style="font-size:0.72rem;color:var(--text-light);margin-top:3px;">Order: ${orderLabel}</div>` : ''}
                        ${showIndividualDelay && step.isIndividualStepDelay ? `<div style="font-size:0.72rem;color:var(--text-light);margin-top:3px;">Slave Delay: ${stepSlaveDelay}ms</div>` : ''}
                        <div class="tpl-validation-msg">${!validation.valid ? validation.msg : ''}</div>
                    </div>`;
                }
            });
            list.innerHTML = html;
            tplUpdateStepTimeTable();
        }

        function tplUpdateStepCard(idx) {
            // Quick update just the position/rotation chips for a step
            const card = document.querySelector(`#tplStepsList .tpl-step-card[data-step-index="${idx}"]`);
            if (!card) return;
            const step = tplSteps[idx];
            const sType = step.stepType || 'movement';
            const inputs = card.querySelectorAll('.tpl-step-pos-chip input');
            if (tplSetup.product === 'hmrs' && sType === 'rotation' && step.rotations) {
                inputs.forEach((inp, pi) => { inp.value = Math.round(tplRotationMetersToDeg(step.rotations[pi] || 0) * 10) / 10; });
            } else {
                inputs.forEach((inp, pi) => { inp.value = step.positions[pi]; });
            }
            tplValidateStep(idx);
        }

        function tplStepPosInput(stepIdx, pillarIdx, el) {
            const val = parseFloat(el.value) || 0;
            tplSteps[stepIdx].positions[pillarIdx] = val;
            tplValidateStep(stepIdx);
            drawTplStepCanvas();
            tplUpdateStepTimeTable();
        }

        function tplStepRotInput(stepIdx, pillarIdx, el) {
            const deg = parseFloat(el.value) || 0;
            const val = tplRotationDegToMeters(deg);
            const maxRot = tplSetup.maxRotation || tplRotationDegToMeters(360);
            const clamped = Math.max(-maxRot, Math.min(maxRot, val));
            if (!tplSteps[stepIdx].rotations) tplSteps[stepIdx].rotations = new Array(tplSetup.pillarCount).fill(0);
            tplSteps[stepIdx].rotations[pillarIdx] = clamped;
            if (el) el.value = Math.round(tplRotationMetersToDeg(clamped) * 10) / 10;
            drawTplStepCanvas();
            tplUpdateStepTimeTable();
        }

        function tplStepTypeChange(stepIdx, newType) {
            tplSteps[stepIdx].stepType = newType;
            if ((newType === 'rotation' || newType === 'all') && !tplSteps[stepIdx].rotations) {
                tplSteps[stepIdx].rotations = new Array(tplSetup.pillarCount).fill(0);
            }
            tplRenderAllStepCards();
            drawTplStepCanvas();
        }

        // ---- Save template to file ----
        async function tplSaveTemplate() {
            // Validate all steps
            for (let i = 0; i < tplSteps.length; i++) {
                const v = tplValidatePositions(tplSteps[i].positions);
                if (!v.valid) {
                    showToast(`Step ${i + 1} has errors: ${v.msg}`);
                    tplSelectStep(i);
                    return;
                }
            }

            if (tplSteps.length === 0) {
                showToast('Add at least one step');
                return;
            }

            tplSyncAutoAccelDecel();
            const velocity = parseInt(document.getElementById('tplCfgVelocity').value) || 120000;
            const accel = parseInt(document.getElementById('tplCfgAccel').value) || 60000;
            const decel = parseInt(document.getElementById('tplCfgDecel').value) || 60000;
            const slaveDelay = parseInt(document.getElementById('tplCfgSlaveDelay').value) || 30;
            const includeHome = !!document.getElementById('tplIncludeHomeStep')?.checked;
            const useIndividualStepDelay = tplIsMatrixProduct(tplSetup?.product);

            const n = tplSetup.pillarCount;
            const isHmrs = tplSetup.product === 'hmrs';
            const tplMeta = {
                product: tplSetup.product,
                track_size_m: tplSetup.trackSize,
                pillar_count: tplSetup.pillarCount,
                pillar_width_m: tplSetup.pillarWidth,
                second_dim_m: tplSetup.secondDim,
                max_left_m: tplSetup.maxLeft,
                max_right_m: tplSetup.maxRight,
                max_rotation_m: tplSetup.maxRotation,
                slave_count: tplSetup.slaveCount
            };

            let config;

            if (isHmrs) {
                // HMRS: rotation_speed, rotation_slaves, even=rotation odd=movement
                const rotVelocity = parseInt(document.getElementById('tplCfgRotVelocity').value) || 4000;
                const rotAccel = parseInt(document.getElementById('tplCfgRotAccel').value) || 2000;
                const rotDecel = parseInt(document.getElementById('tplCfgRotDecel').value) || 2000;
                const rotCspMax = parseInt(document.getElementById('tplCfgRotCspMax').value) || 50;

                const totalSlaves = n * 2;
                const slaveNames = [];
                const rotationSlaves = [];
                const movementSlaves = [];
                for (let i = 0; i < n; i++) {
                    slaveNames.push('Rotation ' + (i + 1)); // even index
                    slaveNames.push('Movement ' + (i + 1)); // odd index
                    rotationSlaves.push(i * 2);
                    movementSlaves.push(i * 2 + 1);
                }

                // Build positions map
                const positions = {};
                positions['home_pos_M'] = new Array(n).fill(0);
                let movCounter = 0;
                let rotCounter = 0;
                tplSteps.forEach((step, idx) => {
                    const sType = step.stepType || 'movement';
                    if (sType === 'rotation' || sType === 'all') {
                        rotCounter++;
                        const rots = step.rotations || new Array(n).fill(0);
                        positions['rot_' + rotCounter] = [...rots];
                    }
                    if (sType === 'movement' || sType === 'all') {
                        movCounter++;
                        positions['pos_' + movCounter] = [...step.positions];
                    }
                });

                // Build steps
                const steps = [];
                if (includeHome) {
                    steps.push({ name: 'Home All', type: 'home', position: 'home_pos_M', delay: tplHomeStepDelay });
                }
                let mIdx = 0, rIdx = 0;
                tplSteps.forEach((step, idx) => {
                    const sType = step.stepType || 'movement';
                    const baseName = tplGetStepDisplayName(step, idx);
                    const moveOrderMode = step.moveOrderMode || 'dynamic';
                    const moveOrderList = tplMapMoveOrderForSave(Array.isArray(step.moveOrderList) ? step.moveOrderList : []);
                    if (sType === 'rotation') {
                        rIdx++;
                        steps.push({
                            name: baseName + ' (Rotate)',
                            type: 'rotation',
                            position: 'rot_' + rIdx,
                            delay: step.delay
                        });
                    } else if (sType === 'all') {
                        rIdx++;
                        mIdx++;
                        steps.push({
                            name: baseName + ' (Move+Rotate)',
                            type: 'all',
                            position: 'pos_' + mIdx,
                            position_rotation: 'rot_' + rIdx,
                            delay: step.delay,
                            move_order: moveOrderMode,
                            move_order_list: moveOrderMode === 'define' ? moveOrderList : undefined
                        });
                    } else {
                        mIdx++;
                        steps.push({
                            name: baseName + ' (Move)',
                            type: 'movement',
                            position: 'pos_' + mIdx,
                            delay: step.delay,
                            move_order: moveOrderMode,
                            move_order_list: moveOrderMode === 'define' ? moveOrderList : undefined
                        });
                    }
                });

                config = {
                    speed: {
                        movement_speed: {
                            velocity,
                            acceleration: accel,
                            deceleration: decel,
                            csp_max_step: 100
                        },
                        rotation_speed: {
                            velocity: rotVelocity,
                            acceleration: rotAccel,
                            deceleration: rotDecel,
                            csp_max_step: rotCspMax
                        }
                    },
                    slaves: {
                        count: totalSlaves,
                        names: slaveNames,
                        movement_slaves: movementSlaves,
                        rotation_slaves: rotationSlaves
                    },
                    positions,
                    template: {
                        name: tplSetup.name,
                        description: '',
                        operation_mode: 'both',
                        is_simultaneous: true,
                        slave_delay_ms: slaveDelay,
                        left_end_position: tplSetup.maxLeft,
                        right_end_position: tplSetup.maxRight,
                        meta: tplMeta,
                        steps
                    }
                };
            } else {
                // Non-HMRS: original behavior
                const slaveNames = [];
                for (let i = 0; i < n; i++) slaveNames.push('Movement ' + (i + 1));
                const movementSlaves = Array.from({ length: n }, (_, i) => i);

                // Build positions map: home + each step
                const positions = {};
                positions['home_pos_M'] = new Array(n).fill(0);
                tplSteps.forEach((step, idx) => {
                    positions['pos_' + (idx + 1)] = [...step.positions];
                });

                // Build steps
                const steps = [];
                if (includeHome) {
                    steps.push({ name: 'Home All', type: 'home', position: 'home_pos_M', delay: tplHomeStepDelay });
                }
                tplSteps.forEach((step, idx) => {
                    const parsedStepSlaveDelay = parseInt(step.slaveDelayMs);
                    const stepSlaveDelay = (useIndividualStepDelay && step.isIndividualStepDelay)
                        ? (Number.isFinite(parsedStepSlaveDelay) ? parsedStepSlaveDelay : slaveDelay)
                        : slaveDelay;
                    const moveOrderMode = step.moveOrderMode || 'dynamic';
                    const moveOrderList = tplMapMoveOrderForSave(Array.isArray(step.moveOrderList) ? step.moveOrderList : []);
                    steps.push({
                        name: tplGetStepDisplayName(step, idx),
                        type: 'movement',
                        position: 'pos_' + (idx + 1),
                        delay: step.delay,
                        move_order: moveOrderMode,
                        move_order_list: moveOrderMode === 'define' ? moveOrderList : undefined,
                        is_simultaneous: false,
                        slave_delay_ms: stepSlaveDelay,
                        is_individual_step_delay: !!(useIndividualStepDelay && step.isIndividualStepDelay)
                    });
                });

                config = {
                    speed: {
                        movement_speed: {
                            velocity,
                            acceleration: accel,
                            deceleration: decel,
                            csp_max_step: 100
                        }
                    },
                    slaves: {
                        count: n,
                        names: slaveNames,
                        movement_slaves: movementSlaves
                    },
                    positions,
                    template: {
                        name: tplSetup.name,
                        description: '',
                        operation_mode: 'movement',
                        is_global: false,
                        is_simultaneous: false,
                        slave_delay_ms: slaveDelay,
                        left_end_position: tplSetup.maxLeft,
                        right_end_position: tplSetup.maxRight,
                        meta: tplMeta,
                        steps
                    }
                };
            }

            const filename = (tplEditingFile || tplSetup.name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');

            try {
                const resp = await fetch('/api/save_template', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename, config })
                });
                const data = await resp.json();
                if (data.success) {
                    showToast('Template saved: ' + filename);
                    tplStepBack(true);

                    // If we came from overlay, return to overlay panels
                    if (tplEditorMode === 'overlay') {
                        if (tplStepReturnTarget !== 'list') backToOverlayTemplates();
                    } else {
                        backToTemplateList();
                    }
                } else {
                    showToast('Save failed: ' + (data.message || data.detail));
                }
            } catch (e) {
                showToast('Save error: ' + e.message);
            }
        }

        // ========================================================
        // Initialize
        // ========================================================
        restoreFromCache();  // Instant UI restore from localStorage before WS connects
        connectWS();
        fetchProduct();
        refreshLicenseStatus();
        // Redraw overlay template preview on resize
        window.addEventListener('resize', () => {
            if (document.getElementById('tplCreateOverlay').style.display === 'flex') {
                drawOverlayTplLayout();
            }
        });
        // Also redraw overlay preview when it becomes visible
        const overlayObs = new MutationObserver(() => {
            if (document.getElementById('tplCreateOverlay').style.display === 'flex') {
                setTimeout(() => drawOverlayTplLayout(), 50);
            }
        });
        overlayObs.observe(document.getElementById('tplCreateOverlay'), { attributes: true, attributeFilter: ['style'] });
        setInterval(refreshLicenseStatus, 60000);
