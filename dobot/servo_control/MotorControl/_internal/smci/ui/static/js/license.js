// ============ Steps Definition ============
const STEPS = [
    { id:'fetch',    text:'Fetching license data',        pct:10  },
    { id:'verify',   text:'Verifying license',            pct:25  },
    { id:'success',  text:'License verified successfully',pct:40  },
    { id:'restart',  text:'Starting motor server',        pct:55  },
    { id:'slaves',   text:'Connecting to EtherCAT slaves',pct:75  },
    { id:'ready',    text:'Preparing dashboard',          pct:95  },
];

function renderSteps(activeId) {
    const c = document.getElementById('stepsContainer');
    c.innerHTML = STEPS.map(s => {
        let cls = 'step';
        let icon = '<div class="spinner"></div>';
        if (activeId === 'done') { cls += ' done'; icon = '&#10003;'; }
        else if (s.id === activeId) { cls += ' active'; icon = '<div class="spinner"></div>'; }
        return `<div class="${cls}" id="step-${s.id}"><span class="step-icon">${icon}</span>${s.text}</div>`;
    }).join('');
}

function setProgress(pct) {
    document.getElementById('progressFill').style.width = pct + '%';
    document.getElementById('progressPct').textContent = pct + '%';
}

function showLoading() {
    document.getElementById('loadingOverlay').classList.add('active');
}

function hideLoading() {
    document.getElementById('loadingOverlay').classList.remove('active');
}

// ============ Upload ============
async function uploadLicense() {
    const fileInput = document.getElementById('licenseFile');
    const msg = document.getElementById('message');
    const btn = document.getElementById('uploadBtn');
    if (!fileInput.files.length) {
        msg.textContent = 'Please select a license file.';
        msg.className = 'note error';
        return;
    }

    btn.disabled = true;
    showLoading();
    renderSteps('fetch');
    setProgress(10);

    const file = fileInput.files[0];
    const buf = await file.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));

    // Step: Verify
    renderSteps('verify');
    setProgress(25);

    try {
        const res = await fetch('/api/license/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data_b64: b64 })
        });
        const data = await res.json();

        if (!data.success) {
            hideLoading();
            msg.textContent = data.error || 'Upload failed.';
            msg.className = 'note error';
            btn.disabled = false;
            return;
        }

        // Step: Success
        renderSteps('success');
        setProgress(40);

        // Step: Restart
        renderSteps('restart');
        setProgress(55);

        // Now poll status until motor is ready (state > 0)
        // We wait for the motor process to fully start
        let ready = false;
        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 500));
            try {
                const r2 = await fetch('/api/license/status?t=' + Date.now());
                const d = await r2.json();
                if (d.valid) {
                    // Check if motor is actually running by checking status
                    try {
                        const r3 = await fetch('/api/status?t=' + Date.now());
                        const st = await r3.json();
                        if (st && typeof st.state !== 'undefined') {
                            ready = true;
                            break;
                        }
                    } catch(e) {
                        // Motor not ready yet, keep waiting
                    }
                }
            } catch(e) {}
        }

        // Step: Slaves
        renderSteps('slaves');
        setProgress(75);

        await new Promise(r => setTimeout(r, 1500));

        // Step: Ready
        renderSteps('ready');
        setProgress(95);

        await new Promise(r => setTimeout(r, 600));

        // Done! (redirect even if EtherCAT has issues — UI handles recovery)
        renderSteps('done');
        setProgress(100);
        document.getElementById('loadingSubtitle').textContent = 'All set! Redirecting...';

        await new Promise(r => setTimeout(r, 500));
        window.location.href = '/';

    } catch (e) {
        hideLoading();
        msg.textContent = 'Network error: ' + e.message;
        msg.className = 'note error';
        btn.disabled = false;
    }
}

// ============ Status Check (no auto-redirect on load) ============
async function fetchStatus() {
    try {
        const res = await fetch('/api/license/status');
        const data = await res.json();
        const box = document.getElementById('statusBox');
        if (data.valid) {
            box.innerHTML = `<span class="ok">Valid</span> | License ID: ${data.license_id || 'N/A'} | Expires: ${data.expiry || 'N/A'}`;
            // Don't auto-redirect on page load — let user upload if they want
        } else {
            box.innerHTML = `<span class="error">Invalid</span> | ${data.reason || 'License required'}`;
        }
    } catch(e) {}
}

fetchStatus();
document.getElementById('uploadBtn').addEventListener('click', uploadLicense);