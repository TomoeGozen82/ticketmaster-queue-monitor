const { ipcRenderer } = require('electron');

// Replace alert() with Electron native dialog
async function showMessageBox(message, type = 'info') {
    await ipcRenderer.invoke('show-message-box', message, type);
}

// Global function to submit captcha (called by button clicks)
window.submitCaptcha = async function(taskId) {
    const captchaInput = document.getElementById(`captcha-${taskId}`);
    const captchaCode = captchaInput.value.trim();
    
    if (!captchaCode) {
        await showMessageBox('Please enter the captcha code!', 'warning');
        return;
    }
    
    // Disable input and button during submission
    captchaInput.disabled = true;
    const submitBtn = document.getElementById(`submit-${taskId}`);
    submitBtn.disabled = true;
    submitBtn.innerText = 'Submitting...';
    
    try {
        const result = await ipcRenderer.invoke('submit-captcha', {
            taskId: taskId,
            captchaCode: captchaCode
        });
        
        if (result.success) {
            // Update the queue link in the table
            let row = generateTable.rows[taskId - 1];
            if (row && result.queueLink) {
                row.cells[3].innerText = result.queueLink.substring(0, 50) + (result.queueLink.length > 50 ? "..." : "");
                row.cells[3].title = result.queueLink;
                
                // Add to generated links array
                generatedQueueLinks.push(result.queueLink);
                
                // Show copy button if this is the first successful generation
                if (generatedQueueLinks.length === 1) {
                    copyAllBtn.style.display = 'inline-block';
                    copyAllBtn.disabled = false;
                }
            }
        } else {
            await showMessageBox(`Captcha submission failed: ${result.message}`, 'error');
            // Re-enable input for retry
            captchaInput.disabled = false;
            submitBtn.disabled = false;
            submitBtn.innerText = 'Submit';
        }
    } catch (error) {
        await showMessageBox(`Error submitting captcha: ${error.message}`, 'error');
        // Re-enable input for retry
        captchaInput.disabled = false;
        submitBtn.disabled = false;
        submitBtn.innerText = 'Submit';
    }
};

window.addEventListener('DOMContentLoaded', () => {
    // Tab switching
    const browserTab = document.getElementById('browserTab');
    const generateTab = document.getElementById('generateTab');
    const browserContent = document.getElementById('browserContent');
    const generateContent = document.getElementById('generateContent');

    // Debug logging
    console.log('Browser tab:', browserTab);
    console.log('Generate tab:', generateTab);
    console.log('Browser content:', browserContent);
    console.log('Generate content:', generateContent);

    // Tab switching functionality
    if (browserTab && generateTab && browserContent && generateContent) {
        browserTab.addEventListener('click', (e) => {
            e.preventDefault();
            console.log('Browser tab clicked');
            
            browserTab.classList.add('active');
            generateTab.classList.remove('active');
            browserContent.classList.add('active');
            generateContent.classList.remove('active');
            
            browserContent.style.display = 'block';
            generateContent.style.display = 'none';
        });

        generateTab.addEventListener('click', (e) => {
            e.preventDefault();
            console.log('Generate tab clicked');
            
            generateTab.classList.add('active');
            browserTab.classList.remove('active');
            generateContent.classList.add('active');
            browserContent.classList.remove('active');
            
            generateContent.style.display = 'block';
            browserContent.style.display = 'none';
        });
    } else {
        console.error('Tab elements not found!');
    }

    // Proxy functionality for browser tab
    const useProxyCheckbox = document.getElementById('useProxy');
    const proxyList = document.getElementById('proxyList');

    useProxyCheckbox.addEventListener('change', function() {
        const isChecked = this.checked;
        proxyList.disabled = !isChecked;
        if (!isChecked) {
            proxyList.value = '';
        }
    });

    // Browser automation elements
    const linksBox = document.getElementById('linksBox');
    const loadBtn = document.getElementById('loadLinksBtn');
    const concurrencyInput = document.getElementById('concurrencyInput');
    const tabsPerBrowserInput = document.getElementById('tabsPerBrowserInput');
    const maxBrowsersInput = document.getElementById('maxBrowsersInput');
    const startBtn = document.getElementById('startBtn');
    const retryBtn = document.getElementById('retryBtn');
    const statusTable = document.getElementById('statusTable').getElementsByTagName('tbody')[0];

    // Generate Queue Links elements
    const useGenerateProxyCheckbox = document.getElementById('useGenerateProxy');
    const generateProxyList = document.getElementById('generateProxyList');
    const eventUrlInput = document.getElementById('eventUrlInput');
    const numBrowsersInput = document.getElementById('numBrowsersInput');
    const generateBtn = document.getElementById('generateBtn');
    const copyAllBtn = document.getElementById('copyAllBtn');
    const generateTable = document.getElementById('generateTable').getElementsByTagName('tbody')[0];

    let allLinks = [];
    let lastFailed = [];
    let taskToBrowserMap = new Map();
    let generatedQueueLinks = [];

    // Input validation for browser tab
    function validateInputs() {
        const concurrency = parseInt(concurrencyInput.value, 10) || 0;
        const tabsPerBrowser = parseInt(tabsPerBrowserInput.value, 10) || 0;
        const maxBrowsers = parseInt(maxBrowsersInput.value, 10) || 0;

        if (concurrency <= 0 || tabsPerBrowser <= 0 || maxBrowsers <= 0) {
            return { valid: false, message: "All values must be positive numbers!" };
        }

        if (concurrency % tabsPerBrowser !== 0) {
            return { 
                valid: false, 
                message: `Concurrency (${concurrency}) must be divisible by Tabs per Browser (${tabsPerBrowser})!` 
            };
        }

        const browsersNeeded = Math.ceil(concurrency / tabsPerBrowser);
        if (browsersNeeded > maxBrowsers) {
            return { 
                valid: false, 
                message: `Need ${browsersNeeded} browsers but Max Browsers is set to ${maxBrowsers}!` 
            };
        }

        return { valid: true };
    }

    // Validate proxy list for browser tab
    function validateProxyList() {
        if (!useProxyCheckbox.checked) {
            return { valid: true };
        }

        const proxyText = proxyList.value.trim();
        if (!proxyText) {
            return { valid: false, message: "Proxy list cannot be empty when 'Use Proxy' is checked!" };
        }

        const proxyLines = proxyText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const invalidProxies = [];

        proxyLines.forEach((proxyString, index) => {
            const proxyParts = proxyString.split(':');
            if (proxyParts.length < 4) {
                invalidProxies.push(`Line ${index + 1}: ${proxyString}`);
            }
        });

        if (invalidProxies.length > 0) {
            return { 
                valid: false, 
                message: `Invalid proxy format(s):\n${invalidProxies.join('\n')}\n\nUse format: host:port:username:password` 
            };
        }

        return { valid: true, proxyCount: proxyLines.length };
    }

    // Real-time validation feedback for browser tab
    function updateValidationStatus() {
        const validation = validateInputs();
        const proxyValidation = validateProxyList();
        const inputs = [concurrencyInput, tabsPerBrowserInput, maxBrowsersInput];
        
        inputs.forEach(input => {
            input.style.borderColor = validation.valid ? '' : '#ff6b6b';
        });

        proxyList.style.borderColor = proxyValidation.valid ? '' : '#ff6b6b';

        const isValid = validation.valid && proxyValidation.valid;
        startBtn.disabled = !isValid;
        
        if (!validation.valid) {
            startBtn.title = validation.message;
        } else if (!proxyValidation.valid) {
            startBtn.title = proxyValidation.message;
        } else {
            startBtn.title = proxyValidation.proxyCount ? `Ready with ${proxyValidation.proxyCount} proxies` : 'Ready (no proxy)';
        }
    }

    // Add validation listeners for browser tab
    concurrencyInput.addEventListener('input', updateValidationStatus);
    tabsPerBrowserInput.addEventListener('input', updateValidationStatus);
    maxBrowsersInput.addEventListener('input', updateValidationStatus);
    proxyList.addEventListener('input', updateValidationStatus);
    useProxyCheckbox.addEventListener('change', updateValidationStatus);

    // Initial validation
    updateValidationStatus();

    // File loading for browser tab
    loadBtn.addEventListener('click', async () => {
        const data = await ipcRenderer.invoke('open-file-dialog');
        if (data) {
            linksBox.value = data;
        }
    });

    // Calculate which browser a task belongs to
    function calculateTaskBrowser(taskId, tabsPerBrowser, maxBrowsers) {
        const taskIndex = taskId - 1;
        const batchSize = tabsPerBrowser * maxBrowsers;
        const batchNumber = Math.floor(taskIndex / batchSize);
        const positionInBatch = taskIndex % batchSize;
        const browserInBatch = Math.floor(positionInBatch / tabsPerBrowser);
        return batchNumber * maxBrowsers + browserInBatch + 1;
    }

    // Browser automation functionality
    startBtn.addEventListener('click', async () => {
        statusTable.innerHTML = "";
        lastFailed = [];
        taskToBrowserMap.clear();
        let links = linksBox.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);

        if (!links.length) {
            await showMessageBox("No links entered!", 'warning');
            return;
        }

        const validation = validateInputs();
        if (!validation.valid) {
            await showMessageBox(validation.message, 'error');
            return;
        }

        const proxyValidation = validateProxyList();
        if (!proxyValidation.valid) {
            await showMessageBox(proxyValidation.message, 'error');
            return;
        }

        let proxyListArray = [];
        if (useProxyCheckbox.checked && proxyList.value.trim()) {
            proxyListArray = proxyList.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        }

        allLinks = links;
        const concurrency = parseInt(concurrencyInput.value, 10);
        const tabsPerBrowser = parseInt(tabsPerBrowserInput.value, 10);
        const maxBrowsers = parseInt(maxBrowsersInput.value, 10);

        startBtn.disabled = true;
        retryBtn.disabled = true;
        linksBox.disabled = true;
        concurrencyInput.disabled = true;
        tabsPerBrowserInput.disabled = true;
        maxBrowsersInput.disabled = true;
        proxyList.disabled = true;
        useProxyCheckbox.disabled = true;

        links.forEach((link, i) => {
            const taskId = i + 1;
            const browserIndex = calculateTaskBrowser(taskId, tabsPerBrowser, maxBrowsers);
            taskToBrowserMap.set(taskId, browserIndex);

            let row = statusTable.insertRow(-1);
            row.insertCell(0).innerText = taskId;
            row.insertCell(1).innerText = link.substring(0, 50) + (link.length > 50 ? "..." : "");
            row.insertCell(2).innerText = "Detecting...";
            row.insertCell(3).innerText = "Waiting...";
        });

        try {
            let { failedLinks } = await ipcRenderer.invoke('run-queue', {
                links,
                concurrency,
                tabsPerBrowser,
                maxBrowsers,
                proxyList: proxyListArray
            });

            lastFailed = failedLinks;

            if (lastFailed.length > 0) {
                await showMessageBox(`Run complete. ${lastFailed.length} failed. Click "Retry Failed" to try again.`, 'info');
            } else {
                await showMessageBox("All links completed successfully!", 'info');
            }
        } catch (error) {
            await showMessageBox(`Error: ${error.message}`, 'error');
        } finally {
            startBtn.disabled = false;
            retryBtn.disabled = lastFailed.length === 0;
            linksBox.disabled = false;
            concurrencyInput.disabled = false;
            tabsPerBrowserInput.disabled = false;
            maxBrowsersInput.disabled = false;
            proxyList.disabled = !useProxyCheckbox.checked;
            useProxyCheckbox.disabled = false;
        }
    });

    // Proxy functionality for generate tab
    useGenerateProxyCheckbox.addEventListener('change', function() {
        const isChecked = this.checked;
        generateProxyList.disabled = !isChecked;
        if (!isChecked) {
            generateProxyList.value = '';
        }
    });

    // Validate generate tab inputs
    function validateGenerateInputs() {
        const eventUrl = eventUrlInput.value.trim();
        const numBrowsers = parseInt(numBrowsersInput.value, 10) || 0;

        if (!eventUrl) {
            return { valid: false, message: "Event URL is required!" };
        }

        if (!eventUrl.includes('ticketmaster')) {
            return { valid: false, message: "Please enter a valid Ticketmaster event URL!" };
        }

        if (numBrowsers <= 0 || numBrowsers > 100) {
            return { valid: false, message: "Number of browsers must be between 1 and 100!" };
        }

        return { valid: true };
    }

    // Validate generate proxy list
    function validateGenerateProxyList() {
        if (!useGenerateProxyCheckbox.checked) {
            return { valid: true };
        }

        const proxyText = generateProxyList.value.trim();
        if (!proxyText) {
            return { valid: false, message: "Proxy list cannot be empty when 'Use Proxy' is checked!" };
        }

        const proxyLines = proxyText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const invalidProxies = [];

        proxyLines.forEach((proxyString, index) => {
            const proxyParts = proxyString.split(':');
            if (proxyParts.length < 4) {
                invalidProxies.push(`Line ${index + 1}: ${proxyString}`);
            }
        });

        if (invalidProxies.length > 0) {
            return { 
                valid: false, 
                message: `Invalid proxy format(s):\n${invalidProxies.join('\n')}\n\nUse format: host:port:username:password` 
            };
        }

        return { valid: true, proxyCount: proxyLines.length };
    }

    // Real-time validation for generate tab
    function updateGenerateValidationStatus() {
        const validation = validateGenerateInputs();
        const proxyValidation = validateGenerateProxyList();
        
        eventUrlInput.style.borderColor = validation.valid ? '' : '#ff6b6b';
        numBrowsersInput.style.borderColor = validation.valid ? '' : '#ff6b6b';
        generateProxyList.style.borderColor = proxyValidation.valid ? '' : '#ff6b6b';

        const isValid = validation.valid && proxyValidation.valid;
        generateBtn.disabled = !isValid;
        
        if (!validation.valid) {
            generateBtn.title = validation.message;
        } else if (!proxyValidation.valid) {
            generateBtn.title = proxyValidation.message;
        } else {
            generateBtn.title = proxyValidation.proxyCount ? `Ready with ${proxyValidation.proxyCount} proxies` : 'Ready (no proxy)';
        }
    }

    // Add validation listeners for generate tab
    eventUrlInput.addEventListener('input', updateGenerateValidationStatus);
    numBrowsersInput.addEventListener('input', updateGenerateValidationStatus);
    generateProxyList.addEventListener('input', updateGenerateValidationStatus);
    useGenerateProxyCheckbox.addEventListener('change', updateGenerateValidationStatus);

    // Initial validation for generate tab
    updateGenerateValidationStatus();

    // Generate Queue Links functionality
    generateBtn.addEventListener('click', async () => {
        generateTable.innerHTML = "";
        generatedQueueLinks = [];
        copyAllBtn.style.display = 'none';
        copyAllBtn.disabled = true;

        const validation = validateGenerateInputs();
        if (!validation.valid) {
            await showMessageBox(validation.message, 'error');
            return;
        }

        const proxyValidation = validateGenerateProxyList();
        if (!proxyValidation.valid) {
            await showMessageBox(proxyValidation.message, 'error');
            return;
        }

        const eventUrl = eventUrlInput.value.trim();
        const numBrowsers = parseInt(numBrowsersInput.value, 10);

        let generateProxyListArray = [];
        if (useGenerateProxyCheckbox.checked && generateProxyList.value.trim()) {
            generateProxyListArray = generateProxyList.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        }

        generateBtn.disabled = true;
        eventUrlInput.disabled = true;
        numBrowsersInput.disabled = true;
        generateProxyList.disabled = true;
        useGenerateProxyCheckbox.disabled = true;

        // Create table rows for all browsers
        for (let i = 1; i <= numBrowsers; i++) {
            let row = generateTable.insertRow(-1);
            row.insertCell(0).innerText = i; // Task ID
            row.insertCell(1).innerText = "Detecting..."; // IP
            row.insertCell(2).innerText = "Waiting..."; // Status
            row.insertCell(3).innerText = ""; // Queue Link
        }

        try {
            const result = await ipcRenderer.invoke('generate-queue-links', {
                eventUrl,
                numBrowsers,
                proxyList: generateProxyListArray
            });

            generatedQueueLinks = result.queueLinks || [];

            if (generatedQueueLinks.length > 0) {
                copyAllBtn.style.display = 'inline-block';
                copyAllBtn.disabled = false;
                await showMessageBox(`Generated ${generatedQueueLinks.length} queue links successfully!`, 'info');
            } else {
                await showMessageBox("No queue links were generated. Please check the event URL and try again.", 'warning');
            }
        } catch (error) {
            await showMessageBox(`Error: ${error.message}`, 'error');
        } finally {
            generateBtn.disabled = false;
            eventUrlInput.disabled = false;
            numBrowsersInput.disabled = false;
            generateProxyList.disabled = !useGenerateProxyCheckbox.checked;
            useGenerateProxyCheckbox.disabled = false;
        }
    });

    // Copy All Queue Links functionality
    copyAllBtn.addEventListener('click', async () => {
        try {
            // Get all generated queue links from main process
            const allQueueLinks = await ipcRenderer.invoke('get-generated-queue-links');
            
            if (allQueueLinks.length === 0) {
                await showMessageBox("No queue links to copy!", 'warning');
                return;
            }

            const allLinks = allQueueLinks.join('\n');
            await navigator.clipboard.writeText(allLinks);
            await showMessageBox(`Copied ${allQueueLinks.length} queue links to clipboard!`, 'info');
        } catch (error) {
            await showMessageBox("Failed to copy to clipboard. Please try again.", 'error');
        }
    });

    // Browser automation task status updates
    ipcRenderer.on('task-update', (event, res) => {
        let rowIndex = res.taskId - 1;
        if (rowIndex >= 0 && rowIndex < statusTable.rows.length) {
            let row = statusTable.rows[rowIndex];
            if (!row) return;

            let statusCell = row.cells[3];
            statusCell.innerText = res.status;
            statusCell.style.background = res.status.includes("Queue Number:") ? "#c6efce"
                : res.status.includes("Failed") || res.status.includes("Error") || res.status.includes("crashed") || res.status.includes("launch failed") || res.status.includes("Unusual activity") ? "#ffc7ce"
                : res.status.includes("Waiting") || res.status.includes("Processing") || res.status.includes("Activity paused") ? "#fffac6"
                : "";
        }
    });

    // Browser IP updates
    ipcRenderer.on('browser-ip-update', (event, res) => {
        const { browserIndex, ip } = res;
        
        for (let i = 0; i < statusTable.rows.length; i++) {
            const row = statusTable.rows[i];
            const taskId = parseInt(row.cells[0].innerText);
            const taskBrowser = taskToBrowserMap.get(taskId);
            
            if (taskBrowser === browserIndex) {
                row.cells[2].innerText = ip;
                row.cells[2].style.color = ip === 'Detection failed' ? '#e74c3c' : 
                                          ip === 'Detecting...' ? '#f39c12' : '#27ae60';
            }
        }
    });

    // Handle captcha detection
    ipcRenderer.on('captcha-detected', (event, res) => {
        const { taskId, captchaImage } = res;
        let rowIndex = taskId - 1;
        
        if (rowIndex >= 0 && rowIndex < generateTable.rows.length) {
            let row = generateTable.rows[rowIndex];
            if (!row) return;

            // Update status column with captcha interface
            let statusCell = row.cells[2];
            statusCell.innerHTML = `
                <div style="text-align: center;">
                    <div style="margin-bottom: 5px; font-weight: bold;">Captcha Required</div>
                    <img src="data:image/png;base64,${captchaImage}" 
                         style="max-width: 120px; max-height: 60px; border: 1px solid #ddd; margin-bottom: 5px;">
                    <div style="display: flex; gap: 5px; align-items: center; justify-content: center;">
                        <input type="text" 
                               id="captcha-${taskId}" 
                               placeholder="Enter captcha" 
                               style="width: 80px; padding: 4px; font-size: 12px; text-align: center;"
                               maxlength="10">
                        <button id="submit-${taskId}" 
                                onclick="submitCaptcha(${taskId})"
                                style="padding: 4px 8px; font-size: 11px; background: #28a745; color: white; border: none; border-radius: 3px; cursor: pointer;">
                            Submit
                        </button>
                    </div>
                </div>
            `;
            statusCell.style.background = "#fff3cd"; // Yellow background for captcha
        }
    });

    // Generate Queue Links status updates
    ipcRenderer.on('generate-update', (event, res) => {
        const { taskId, status, ip, queueLink } = res;
        let rowIndex = taskId - 1;
        
        if (rowIndex >= 0 && rowIndex < generateTable.rows.length) {
            let row = generateTable.rows[rowIndex];
            if (!row) return;

            // Update IP if provided
            if (ip) {
                let ipCell = row.cells[1];
                ipCell.innerText = ip;
                ipCell.style.color = ip === 'Detection failed' ? '#e74c3c' : 
                                   ip === 'Detecting...' ? '#f39c12' : '#27ae60';
            }

            // Update status (only if not captcha interface)
            if (!status.includes('Captcha Required')) {
                let statusCell = row.cells[2];
                statusCell.innerText = status;
                statusCell.style.background = status.includes("Queue ID extracted") ? "#c6efce"
                    : status.includes("Error") || status.includes("Failed") ? "#ffc7ce"
                    : status.includes("Solving captcha") || status.includes("Loading") || status.includes("Processing") ? "#fffac6"
                    : "";
            }

            // Update queue link if provided
            if (queueLink) {
                let linkCell = row.cells[3];
                linkCell.innerText = queueLink.substring(0, 50) + (queueLink.length > 50 ? "..." : "");
                linkCell.title = queueLink; // Show full URL on hover
            }
        }
    });

    // Generate browser IP updates
    ipcRenderer.on('generate-ip-update', (event, res) => {
        const { browserIndex, ip } = res;
        
        if (browserIndex >= 1 && browserIndex <= generateTable.rows.length) {
            let row = generateTable.rows[browserIndex - 1];
            if (row) {
                row.cells[1].innerText = ip;
                row.cells[1].style.color = ip === 'Detection failed' ? '#e74c3c' : 
                                         ip === 'Detecting...' ? '#f39c12' : '#27ae60';
            }
        }
    });

    // Retry functionality for browser automation
    retryBtn.addEventListener('click', async () => {
        if (!lastFailed.length) {
            await showMessageBox("No failed links!", 'info');
            return;
        }

        const validation = validateInputs();
        if (!validation.valid) {
            await showMessageBox(validation.message, 'error');
            return;
        }

        const proxyValidation = validateProxyList();
        if (!proxyValidation.valid) {
            await showMessageBox(proxyValidation.message, 'error');
            return;
        }

        let proxyListArray = [];
        if (useProxyCheckbox.checked && proxyList.value.trim()) {
            proxyListArray = proxyList.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        }

        for (let i = 0; i < allLinks.length; ++i) {
            if (lastFailed.includes(allLinks[i])) {
                let row = statusTable.rows[i];
                row.cells[2].innerText = "Detecting...";
                row.cells[3].innerText = "Waiting (retry)...";
                row.cells[3].style.background = "";
            }
        }

        startBtn.disabled = true;
        retryBtn.disabled = true;
        linksBox.disabled = true;
        concurrencyInput.disabled = true;
        tabsPerBrowserInput.disabled = true;
        maxBrowsersInput.disabled = true;
        proxyList.disabled = true;
        useProxyCheckbox.disabled = true;

        const concurrency = parseInt(concurrencyInput.value, 10);
        const tabsPerBrowser = parseInt(tabsPerBrowserInput.value, 10);
        const maxBrowsers = parseInt(maxBrowsersInput.value, 10);

        try {
            let { failedLinks } = await ipcRenderer.invoke('run-queue', {
                links: lastFailed,
                concurrency,
                tabsPerBrowser,
                maxBrowsers,
                proxyList: proxyListArray
            });

            lastFailed = failedLinks;

            if (lastFailed.length > 0) {
                await showMessageBox(`Retry complete. ${lastFailed.length} still failed.`, 'info');
            } else {
                await showMessageBox("All retries completed successfully!", 'info');
            }
        } catch (error) {
            await showMessageBox(`Error: ${error.message}`, 'error');
        } finally {
            startBtn.disabled = false;
            retryBtn.disabled = lastFailed.length === 0;
            linksBox.disabled = false;
            concurrencyInput.disabled = false;
            tabsPerBrowserInput.disabled = false;
            maxBrowsersInput.disabled = false;
            proxyList.disabled = !useProxyCheckbox.checked;
            useProxyCheckbox.disabled = false;
        }
    });

    // Add cleanup when window closes
    window.addEventListener('beforeunload', async () => {
        try {
            await ipcRenderer.invoke('close-generate-browsers');
        } catch (error) {
            console.error('Error closing browsers on exit:', error);
        }
    });
});
