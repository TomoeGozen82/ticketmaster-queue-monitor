const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Add EasyOCR for CAPTCHA solving
const { EasyOCR } = require('node-easyocr');

puppeteer.use(StealthPlugin());

let mainWindow;
let activeBrowsers = [];
let isProcessing = false;
let browserIPMap = new Map();
let taskToBrowserMap = new Map();
let proxyRotationIndex = 0;
let manuallyClosedBrowsers = new Set();
let programClosedBrowsers = new Set();

// Initialize OCR once
const ocr = new EasyOCR();

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        },
        icon: path.join(__dirname, 'assets', 'icon.png')
    });

    mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// Dialog handler for fixing Windows input freeze bug
ipcMain.handle('show-message-box', async (event, message, type = 'info') => {
    const result = await dialog.showMessageBox({
        type: type,
        buttons: ['OK'],
        title: 'Ticketmaster Queue Monitor',
        message: message,
        icon: null
    });
    return result;
});

// File dialog handler
ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [
            { name: 'Text Files', extensions: ['txt'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });

    if (!result.canceled && result.filePaths.length > 0) {
        try {
            const content = fs.readFileSync(result.filePaths[0], 'utf-8');
            return content;
        } catch (error) {
            console.error('Error reading file:', error);
            return null;
        }
    }
    return null;
});

// Parse multiple proxy configurations
function parseProxyList(proxyListString) {
    if (!proxyListString || !proxyListString.trim()) {
        return [];
    }

    const proxyLines = proxyListString.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const parsedProxies = [];

    proxyLines.forEach((proxyString, index) => {
        const proxyParts = proxyString.split(':');
        if (proxyParts.length >= 4) {
            parsedProxies.push({
                host: proxyParts[0],
                port: proxyParts[1],
                username: proxyParts[2],
                password: proxyParts.slice(3).join(':'),
                index: index + 1
            });
        } else {
            console.warn(`Invalid proxy format at line ${index + 1}: ${proxyString}`);
        }
    });

    return parsedProxies;
}

// Get next proxy in rotation
function getNextProxy(proxyList) {
    if (!proxyList || proxyList.length === 0) {
        return null;
    }

    const proxy = proxyList[proxyRotationIndex % proxyList.length];
    proxyRotationIndex++;
    console.log(`Assigning proxy ${proxy.index} (${proxy.host}:${proxy.port}) - rotation index: ${proxyRotationIndex}`);
    return proxy;
}

// CAPTCHA Detection Function
async function isCaptchaPageLoaded(page) {
    return await page.evaluate(() => {
        const captchaImage = document.querySelector('img.captcha-code');
        const captchaInput = document.querySelector('input[name="CaptchaCode"]');
        const submitButton = document.querySelector('button.botdetect-button');
        const botDetectDiv = document.querySelector('#botdetect-challenge');
        
        return (captchaImage !== null) || 
               (captchaInput !== null) || 
               (submitButton !== null) || 
               (botDetectDiv !== null);
    });
}

// CAPTCHA Solving Function with EasyOCR - FIXED VERSION
async function solveCaptchaWithOCR(page, taskId) {
    try {
        console.log(`Task ${taskId}: CAPTCHA detected, attempting to solve with OCR...`);
        
        // Update status to show OCR is working
        mainWindow.webContents.send('generate-update', {
            taskId: taskId,
            status: 'Solving CAPTCHA with OCR...'
        });
        
        // Step 1: Find and screenshot the CAPTCHA image
        const captchaImage = await page.$('img.captcha-code');
        if (!captchaImage) {
            console.log(`Task ${taskId}: CAPTCHA image not found`);
            return false;
        }
        
        // Step 2: Take screenshot of just the CAPTCHA image
        const captchaImagePath = `captcha_${taskId}_${Date.now()}.png`;
        await captchaImage.screenshot({ path: captchaImagePath });
        
        // Step 3: Use EasyOCR to read the text
        await ocr.init(['en']); // Initialize with English
        const ocrResults = await ocr.readText(captchaImagePath);
        
        // Step 4: Extract the text from OCR results
        let captchaText = '';
        if (ocrResults && ocrResults.length > 0) {
            // Get the text with highest confidence and clean it
            captchaText = ocrResults[0].text.replace(/[^A-Za-z0-9]/g, '');
            console.log(`Task ${taskId}: OCR extracted text: ${captchaText}`);
        }
        
        if (!captchaText || captchaText.length < 4) {
            console.log(`Task ${taskId}: Could not extract valid text from CAPTCHA`);
            
            // Update status to show OCR failed, will try manual input
            mainWindow.webContents.send('generate-update', {
                taskId: taskId,
                status: 'OCR failed - manual input required'
            });
            
            // Send CAPTCHA image to renderer for manual input
            const captchaScreenshot = await captchaImage.screenshot({
                encoding: 'base64',
                type: 'png'
            });
            
            mainWindow.webContents.send('captcha-detected', {
                taskId: taskId,
                captchaImage: captchaScreenshot
            });
            
            // Clean up the temporary image file
            if (fs.existsSync(captchaImagePath)) {
                fs.unlinkSync(captchaImagePath);
            }
            
            return false; // Will wait for manual input
        }
        
        // Step 5: Clear any existing text and enter the CAPTCHA text
        await page.click('input[name="CaptchaCode"]');
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.type('input[name="CaptchaCode"]', captchaText);
        
        // Update status to show submitting
        mainWindow.webContents.send('generate-update', {
            taskId: taskId,
            status: `Submitting OCR result: ${captchaText}`
        });
        
        // Step 6: FIXED - Properly handle navigation after clicking submit
        try {
            // Set up navigation promise BEFORE clicking
            const navigationPromise = page.waitForNavigation({ 
                waitUntil: 'networkidle2', 
                timeout: 15000 
            });
            
            // Click the submit button
            await page.click('button.botdetect-button');
            
            // Wait for navigation to complete
            await navigationPromise;
            
            console.log(`Task ${taskId}: Navigation completed after CAPTCHA submission`);
            
        } catch (navError) {
            console.log(`Task ${taskId}: Navigation error after CAPTCHA: ${navError.message}`);
            // Continue anyway - sometimes navigation doesn't occur
        }
        
        // Step 7: Wait a bit more for page to stabilize
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Step 8: Clean up the temporary image file
        if (fs.existsSync(captchaImagePath)) {
            fs.unlinkSync(captchaImagePath);
        }
        
        console.log(`Task ${taskId}: CAPTCHA solved successfully with OCR!`);
        
        // Update status to show success
        mainWindow.webContents.send('generate-update', {
            taskId: taskId,
            status: 'CAPTCHA solved - extracting queue link...'
        });
        
        return true;
        
    } catch (error) {
        console.error(`Task ${taskId}: Error solving CAPTCHA:`, error);
        
        // Update status to show error
        mainWindow.webContents.send('generate-update', {
            taskId: taskId,
            status: `CAPTCHA error: ${error.message}`
        });
        
        return false;
    }
}

// Extract Queue Link Function - CORRECTED VERSION
async function extractQueueLink(page, taskId) {
    try {
        console.log(`Task ${taskId}: Starting queue link extraction...`);
        
        // Wait for page to load
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Get current URL
        const currentUrl = await page.url();
        console.log(`Task ${taskId}: ACTUAL URL LOADED: ${currentUrl}`);
        
        // Get page title
        const pageTitle = await page.title();
        console.log(`Task ${taskId}: PAGE TITLE: "${pageTitle}"`);
        
        // Get page content preview
        const pageContent = await page.content();
        console.log(`Task ${taskId}: PAGE CONTENT LENGTH: ${pageContent.length}`);
        console.log(`Task ${taskId}: CONTENT PREVIEW: ${pageContent.substring(0, 1000)}`);
        
        // Check if it's a queue page
        if (currentUrl.includes('queue') || currentUrl.includes('waiting')) {
            console.log(`Task ${taskId}: ✅ QUEUE URL DETECTED: ${currentUrl}`);
            return currentUrl;
        } else {
            console.log(`Task ${taskId}: ❌ NOT A QUEUE URL - Regular page detected`);
            console.log(`Task ${taskId}: Expected queue keywords not found in URL`);
        }
        
        // Method 2: Look for UUID in page content with error handling
        try {
            const queueId = await page.evaluate(() => {
                const uuidRegex = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;
                const pageText = document.body.innerText || document.body.textContent;
                const match = pageText.match(uuidRegex);
                return match ? match[0] : null;
            });
            
            if (queueId) {
                const baseUrl = new URL(currentUrl).origin;
                const queueLink = `${baseUrl}/queue/${queueId}`;
                console.log(`Task ${taskId}: Queue link constructed: ${queueLink}`);
                return queueLink;
            }
        } catch (evalError) {
            console.log(`Task ${taskId}: Error evaluating page content: ${evalError.message}`);
        }
        
        // Method 3: Look for queue links in page with error handling
        try {
            const queueLink = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a[href*="queue"]'));
                return links.length > 0 ? links[0].href : null;
            });
            
            if (queueLink) {
                console.log(`Task ${taskId}: Queue link found in page: ${queueLink}`);
                return queueLink;
            }
        } catch (linkError) {
            console.log(`Task ${taskId}: Error finding queue links: ${linkError.message}`);
        }
        
        return null;
        
    } catch (error) {
        console.error(`Task ${taskId}: Error extracting queue link:`, error.message);
        return null;
    }
}

// Check if error indicates browser connection issues
function isBrowserConnectionError(error) {
    const errorMessage = error.message.toLowerCase();
    return errorMessage.includes('target closed') ||
           errorMessage.includes('protocol error') ||
           errorMessage.includes('detached frame') ||
           errorMessage.includes('session closed') ||
           errorMessage.includes('connection closed');
}

// Determine appropriate error status - only manual if truly manual
function getBrowserClosureStatus(browserIndex, defaultStatus = 'Browser connection lost') {
    // Check if this browser was manually closed (and not program-closed)
    if (manuallyClosedBrowsers.has(browserIndex)) {
        return 'Browser manually closed';
    }
    
    // Return the provided default status for automatic closures
    return defaultStatus;
}

// NEW: Log unknown Ticketmaster pages for debugging
async function logUnknownTicketmasterPage(page, taskId, pageContent, pageText) {
    try {
        const timestamp = new Date().toISOString();
        const logData = {
            taskId: taskId,
            timestamp: timestamp,
            url: page.url(),
            pageTitle: await page.title().catch(() => 'Unknown'),
            htmlContent: pageContent.substring(0, 5000), // First 5000 chars
            textContent: pageText.substring(0, 2000), // First 2000 chars
            userAgent: await page.evaluate(() => navigator.userAgent).catch(() => 'Unknown')
        };
        
        // Create logs directory if it doesn't exist
        const logsDir = path.join(__dirname, 'logs');
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir);
        }
        
        // Save log to file
        const logFileName = `unknown_ticketmaster_page_${taskId}_${Date.now()}.json`;
        const logFilePath = path.join(logsDir, logFileName);
        fs.writeFileSync(logFilePath, JSON.stringify(logData, null, 2));
        
        console.log(`[${taskId}] 📝 Unknown Ticketmaster page logged to: ${logFileName}`);
    } catch (error) {
        console.error(`[${taskId}] Error logging unknown page:`, error.message);
    }
}

// NEW: Setup real-time page transition monitoring
async function setupPageTransitionMonitoring(page, taskId, onTransition) {
    try {
        console.log(`[${taskId}] Setting up real-time page transition monitoring...`);
        
        // Set up MutationObserver for real-time DOM change detection
        await page.evaluate(() => {
            if (window.queuePageObserver) {
                window.queuePageObserver.disconnect();
            }
            
            window.queuePageObserver = new MutationObserver((mutations) => {
                // Check if significant content changes occurred
                const hasSignificantChanges = mutations.some(mutation => {
                    return mutation.type === 'childList' && mutation.addedNodes.length > 0;
                });
                
                if (hasSignificantChanges) {
                    // Trigger page re-analysis
                    window.pageTransitionDetected = true;
                }
            });
            
            // Start observing
            window.queuePageObserver.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true
            });
            
            window.pageTransitionDetected = false;
        });
        
        // Polling loop to check for transitions
        const checkForTransitions = async () => {
            try {
                const transitionDetected = await page.evaluate(() => {
                    if (window.pageTransitionDetected) {
                        window.pageTransitionDetected = false;
                        return true;
                    }
                    return false;
                });
                
                if (transitionDetected) {
                    console.log(`[${taskId}] 🔄 Page transition detected - re-analyzing...`);
                    await onTransition();
                }
                
            } catch (error) {
                console.log(`[${taskId}] Error checking transitions: ${error.message}`);
            }
        };
        
        // Check every 2 seconds for transitions
        const transitionInterval = setInterval(checkForTransitions, 2000);
        
        // Store interval reference for cleanup
        page.transitionInterval = transitionInterval;
        
    } catch (error) {
        console.error(`[${taskId}] Error setting up transition monitoring:`, error.message);
    }
}

// Fast browser and page closing with timeout
async function fastClose(page, browser, browserIndex, timeoutMs = 3000) {
    const closeOperations = [];
    
    try {
        // Mark as program-closed before closing
        if (browserIndex) {
            programClosedBrowsers.add(browserIndex);
        }
        
        // Close all pages first (from search results - prevents hanging)
        if (browser && !browser.disconnected) {
            const pages = await browser.pages();
            for (const p of pages) {
                if (!p.isClosed()) {
                    closeOperations.push(
                        Promise.race([
                            p.close(),
                            new Promise(resolve => setTimeout(resolve, 1000))
                        ])
                    );
                }
            }
            
            // Wait for all pages to close or timeout
            await Promise.race([
                Promise.all(closeOperations),
                new Promise(resolve => setTimeout(resolve, timeoutMs))
            ]);
        }
        
        // Close browser with timeout
        if (browser && !browser.disconnected) {
            await Promise.race([
                browser.close(),
                new Promise(resolve => setTimeout(resolve, timeoutMs))
            ]);
        }
        
    } catch (error) {
        console.error(`Fast close error for browser ${browserIndex}:`, error.message);
        
        // Force kill browser process if close fails
        try {
            if (browser && browser.process()) {
                const process = browser.process();
                if (process && !process.killed) {
                    process.kill('SIGKILL');
                    console.log(`Force killed browser ${browserIndex} process`);
                }
            }
        } catch (killError) {
            console.error(`Force kill failed for browser ${browserIndex}:`, killError.message);
        }
    }
}

// FIXED: Wait for page to finish loading with proper error classification
async function waitForPageStable(page, taskId, updateStatus, browserIndex) {
    console.log(`Task ${taskId}: Checking page stability...`);
    updateStatus('Checking page stability...');
    
    try {
        // Simple approach: wait a fixed time then check if page is accessible
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        const title = await page.title();
        const content = await page.content();
        
        console.log(`Task ${taskId}: Page accessible - title: "${title}", content length: ${content.length}`);
        return { title, content };
        
    } catch (error) {
        if (isBrowserConnectionError(error)) {
            const status = getBrowserClosureStatus(browserIndex, 'Browser connection lost');
            console.log(`Task ${taskId}: ${status}`);
            throw new Error(status);
        }
        
        console.log(`Task ${taskId}: Page stability check failed: ${error.message}`);
        throw error;
    }
}

// Check activity paused with proper error classification
async function checkActivityPausedWithRetry(page, taskId, updateStatus, browserIndex) {
    console.log(`Task ${taskId}: Checking activity paused status...`);
    
    while (true) {
        try {
            // Try to get title
            const title = await page.title();
            console.log(`Task ${taskId}: Checking title: "${title}"`);
            
            // Check if title indicates activity paused
            const titleHasPaused = title.toLowerCase().includes('your browsing activity has been paused') ||
                                 title.toLowerCase().includes('browsing activity has been paused') ||
                                 title.toLowerCase().includes('activity has been paused') ||
                                 (title.toLowerCase().includes('browsing activity') && title.toLowerCase().includes('paused'));
            
            if (!titleHasPaused) {
                console.log(`Task ${taskId}: Title OK - no activity paused indication`);
                return { isActivityPaused: false };
            }
            
            console.log(`Task ${taskId}: Activity paused title detected - waiting 10 seconds...`);
            updateStatus('Activity paused title detected - waiting 10 seconds...');
            
            // Wait 10 seconds
            await new Promise(resolve => setTimeout(resolve, 10000));
            
            // Check title again after wait (with navigation error handling)
            let titleAfterWait;
            while (true) {
                try {
                    titleAfterWait = await page.title();
                    break; // Success
                } catch (error) {
                    if (isBrowserConnectionError(error)) {
                        const status = getBrowserClosureStatus(browserIndex, 'Browser connection lost during activity check');
                        console.log(`Task ${taskId}: ${status}`);
                        throw new Error(status);
                    } else if (error.message.includes('Execution context was destroyed')) {
                        console.log(`Task ${taskId}: Context destroyed during title recheck - waiting 3 seconds...`);
                        updateStatus('Page loading during activity check - waiting...');
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        continue; // Try again
                    } else {
                        throw error; // Real error
                    }
                }
            }
            
            console.log(`Task ${taskId}: Title after wait: "${titleAfterWait}"`);
            
            const stillPaused = titleAfterWait.toLowerCase().includes('your browsing activity has been paused') ||
                              titleAfterWait.toLowerCase().includes('browsing activity has been paused') ||
                              titleAfterWait.toLowerCase().includes('activity has been paused') ||
                              (titleAfterWait.toLowerCase().includes('browsing activity') && titleAfterWait.toLowerCase().includes('paused'));
            
            if (stillPaused) {
                console.log(`Task ${taskId}: Still paused after wait - unusual activity detected`);
                updateStatus('Unusual activity detected');
                return { isActivityPaused: true, shouldClose: true };
            } else {
                console.log(`Task ${taskId}: No longer paused after wait - continuing monitoring`);
                updateStatus('Activity paused resolved - continuing monitoring...');
                return { isActivityPaused: false };
            }
            
        } catch (error) {
            if (error.message.includes('Browser manually closed') ||
                error.message.includes('Browser connection lost')) {
                throw error; // Re-throw browser closure errors with proper status
            } else if (isBrowserConnectionError(error)) {
                const status = getBrowserClosureStatus(browserIndex, 'Browser connection lost during activity check');
                console.log(`Task ${taskId}: ${status}`);
                throw new Error(status);
            } else if (error.message.includes('Execution context was destroyed')) {
                console.log(`Task ${taskId}: Context destroyed during activity check - waiting 3 seconds...`);
                updateStatus('Page loading during activity check - waiting...');
                await new Promise(resolve => setTimeout(resolve, 3000));
                continue; // Try again
            } else {
                console.log(`Task ${taskId}: Error checking activity paused: ${error.message}`);
                return { isActivityPaused: false }; // Assume not paused on real errors
            }
        }
    }
}

// CORRECTED: Queue page detection with proper distinction
async function detectQueuePageType(page, taskId) {
    try {
        console.log(`[${taskId}] Starting enhanced page type detection...`);
        
        // Get page content for analysis
        const pageContent = await page.content();
        const pageText = await page.evaluate(() => document.body.innerText || document.body.textContent || '');
        
        // Check for ACTIVE QUEUE ROOM (assigned queue number)
        console.log(`[${taskId}] Checking for active queue room...`);
        
        // Method A: Look for actual assigned queue number display
        const hasAssignedQueueNumber = pageText.includes('Your queue number:') && 
                                      pageText.match(/Your queue number:\s*\d+/i);
        
        // Method B: Check for queue progress indicators
        const hasQueueProgress = pageText.includes('people ahead of you') ||
                               pageText.includes('estimated wait time') ||
                               pageText.includes('Queue position:');
        
        if (hasAssignedQueueNumber || hasQueueProgress) {
            console.log(`[${taskId}] ✅ Detected as ACTIVE QUEUE ROOM`);
            return { pageState: 'queue-assigned', isQueuePage: true, pageType: 'queue-assigned' };
        }
        
        // Check for PRE-QUEUE/WAITING ROOM (what you're actually seeing)
        console.log(`[${taskId}] Checking for pre-queue/waiting room...`);
        const hasCountdownTimer = pageText.includes('Minutes') && pageText.includes('Seconds');
        const hasPreQueueMessage = pageText.includes('automatically placed in the queue when') ||
                                  pageText.includes('The event will begin at:') ||
                                  pageText.includes('sale begins');
        
        if (hasCountdownTimer || hasPreQueueMessage) {
            console.log(`[${taskId}] ✅ Detected as PRE-QUEUE/WAITING ROOM`);
            return { pageState: 'pre-queue-waiting', isQueuePage: true, pageType: 'pre-queue-waiting' };
        }
        
        // Check for Processing Room
        console.log(`[${taskId}] Checking for processing room...`);
        if (pageText.includes('Your place in the Queue is currently being processed')) {
            console.log(`[${taskId}] ✅ Detected as PROCESSING ROOM`);
            return { pageState: 'queue-processing', isQueuePage: true, pageType: 'queue-processing' };
        }
        
        // Page not recognized as any queue type
        console.log(`[${taskId}] ❌ Page not recognized as any queue type`);
        return { pageState: 'regular-page', isQueuePage: false };
        
    } catch (error) {
        console.error(`[${taskId}] Error in detectQueuePageType:`, error.message);
        return { pageState: 'regular-page', isQueuePage: false };
    }
}


// ENHANCED: Helper function to extract queue number with dual methods
async function extractQueueNumber(page, taskId) {
    try {
        console.log(`[${taskId}] Starting enhanced queue number extraction...`);
        
        // Method A: Try to extract from HTML element with data-bind attribute
        try {
            const queueElement = await page.$('[data-bind="text: ticket.queueNumber"]');
            if (queueElement) {
                const queueNumber = await queueElement.evaluate(el => el.textContent || el.innerText);
                if (queueNumber && !isNaN(parseInt(queueNumber))) {
                    console.log(`[${taskId}] ✅ Queue number extracted via Method A: ${queueNumber}`);
                    return parseInt(queueNumber);
                }
            }
        } catch (error) {
            console.log(`[${taskId}] Method A failed: ${error.message}`);
        }
        
        // Method B: Try to extract from text content (fallback)
        try {
            const pageContent = await page.content();
            const queueMatch = pageContent.match(/Your queue number:\s*(\d+)/i);
            if (queueMatch && queueMatch[1]) {
                const queueNumber = parseInt(queueMatch[1]);
                console.log(`[${taskId}] ✅ Queue number extracted via Method B: ${queueNumber}`);
                return queueNumber;
            }
        } catch (error) {
            console.log(`[${taskId}] Method B failed: ${error.message}`);
        }
        
        console.log(`[${taskId}] ❌ Failed to extract queue number with both methods`);
        return null;
        
    } catch (error) {
        console.error(`[${taskId}] Error in extractQueueNumber:`, error.message);
        return null;
    }
}

// Helper function to parse countdown time
function parseCountdown(content) {
    const minutesSecondsMatch = content.match(/(\d+)\s*minutes?\s*(\d+)\s*seconds?/i);
    if (minutesSecondsMatch) {
        const minutes = parseInt(minutesSecondsMatch[1]);
        const seconds = parseInt(minutesSecondsMatch[2]);
        return (minutes * 60) + seconds;
    }
    
    const secondsMatch = content.match(/(\d+)\s*seconds?/i);
    if (secondsMatch) {
        return parseInt(secondsMatch[1]);
    }
    
    return null;
}

// IP Detection function with browser IP tracking
async function detectBrowserIP(browser, browserIndex) {
    let testPage = null;
    try {
        testPage = await browser.newPage();
        await testPage.goto('https://httpbin.org/ip', {
            timeout: 15000,
            waitUntil: 'networkidle0'
        });
        
        // Wait for content to fully render
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        const ipData = await testPage.evaluate(() => {
            try {
                const bodyText = document.body.innerText || document.body.textContent;
                return JSON.parse(bodyText);
            } catch (e) {
                // If JSON parse fails, try to extract IP with regex
                const bodyText = document.body.innerText || document.body.textContent;
                const ipMatch = bodyText.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
                return { origin: ipMatch ? ipMatch[0] : 'Parse failed' };
            }
        });
        
        const detectedIP = ipData.origin || 'Detection failed';
        
        // Update browser IP mapping
        browserIPMap.set(browserIndex, detectedIP);
        
        // Update all tasks for this browser with the detected IP
        updateTasksIPForBrowser(browserIndex, detectedIP);
        
        return detectedIP;
        
    } catch (error) {
        console.error('IP detection error:', error.message);
        
        // Try alternative IP detection service as fallback
        try {
            await testPage.goto('https://api.ipify.org?format=json', {
                timeout: 10000,
                waitUntil: 'networkidle0'
            });
            
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            const fallbackData = await testPage.evaluate(() => {
                try {
                    const bodyText = document.body.innerText || document.body.textContent;
                    const parsed = JSON.parse(bodyText);
                    return parsed.ip || 'Fallback failed';
                } catch (e) {
                    return 'Fallback failed';
                }
            });
            
            const fallbackIP = fallbackData;
            browserIPMap.set(browserIndex, fallbackIP);
            updateTasksIPForBrowser(browserIndex, fallbackIP);
            return fallbackIP;
            
        } catch (fallbackError) {
            console.error('Fallback IP detection also failed:', fallbackError.message);
            const failedIP = 'Detection failed';
            browserIPMap.set(browserIndex, failedIP);
            updateTasksIPForBrowser(browserIndex, failedIP);
            return failedIP;
        }
        
    } finally {
        if (testPage && !testPage.isClosed()) {
            try {
                await Promise.race([
                    testPage.close(),
                    new Promise(resolve => setTimeout(resolve, 2000))
                ]);
            } catch (e) {
                console.error('Error closing IP detection page:', e.message);
            }
        }
    }
}

// Update IP for all tasks belonging to a specific browser
function updateTasksIPForBrowser(browserIndex, ip) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        // Send IP update for all tasks of this browser
        mainWindow.webContents.send('browser-ip-update', {
            browserIndex: browserIndex,
            ip: ip
        });
    }
}

// ENHANCED: Smart page monitoring with improved transition detection - COMPLETE FIXED VERSION
async function smartPageMonitoring(page, taskId, updateStatus, isUsingProxy, browserIndex) {
    const maxTotalTime = 300000; // 5 minutes for pre-queue waiting
    const startTime = Date.now();
    let consecutiveRegularPageDetections = 0;
    let lastDetectedState = null;
    
    while (Date.now() - startTime < maxTotalTime) {
        // STEP 1: Wait for page to be stable (ignore navigation errors)
        let pageData;
        try {
            pageData = await waitForPageStable(page, taskId, updateStatus, browserIndex);
        } catch (error) {
            if (error.message.includes('Browser manually closed') ||
                error.message.includes('Browser connection lost')) {
                return { shouldClose: true, status: error.message };
            }
            
            updateStatus(`Error waiting for page stability: ${error.message}`);
            return { shouldClose: true, status: `Error: ${error.message}` };
        }
        
        // STEP 2: Check activity paused (with navigation error handling)
        let activityCheck;
        try {
            activityCheck = await checkActivityPausedWithRetry(page, taskId, updateStatus, browserIndex);
        } catch (error) {
            if (error.message.includes('Browser manually closed') ||
                error.message.includes('Browser connection lost')) {
                return { shouldClose: true, status: error.message };
            }
            
            updateStatus(`Error checking activity paused: ${error.message}`);
            return { shouldClose: true, status: `Error: ${error.message}` };
        }
        
        if (activityCheck.isActivityPaused && activityCheck.shouldClose) {
            return { shouldClose: true, status: 'Unusual activity detected' };
        }
        
        // STEP 3: Enhanced queue page detection
        const pageState = await detectQueuePageType(page, taskId);
        
        // Only update status if state changed to avoid spam
        if (pageState.pageState !== lastDetectedState) {
            console.log(`[${taskId}] Page state changed: ${lastDetectedState} → ${pageState.pageState}`);
            lastDetectedState = pageState.pageState;
        }
        
        switch (pageState.pageState) {
            case 'pre-queue-waiting':
                // FIXED: Stay in monitoring loop for pre-queue - don't return immediately
                if (lastDetectedState !== 'pre-queue-waiting') {
                    updateStatus('Pre-queue waiting room - monitoring for queue activation...');
                    console.log(`[${taskId}] Entering pre-queue monitoring mode`);
                }
                
                // Wait longer between checks for pre-queue to avoid spam
                await new Promise(resolve => setTimeout(resolve, 15000)); // 15 second intervals
                continue; // Stay in the monitoring loop - THIS IS KEY
                
            case 'queue-waiting-room':
                // FIXED: Stay in monitoring loop for actual queue
                if (lastDetectedState !== 'queue-waiting-room') {
                    updateStatus('Queue waiting room - monitoring for position updates...');
                    console.log(`[${taskId}] Entering queue waiting room monitoring mode`);
                }
                
                await new Promise(resolve => setTimeout(resolve, 20000)); // 20 second intervals
                continue; // Stay in the monitoring loop
                
            case 'queue-processing':
                // FIXED: Stay in monitoring loop for processing
                if (lastDetectedState !== 'queue-processing') {
                    updateStatus('Queue processing - monitoring for completion...');
                    console.log(`[${taskId}] Entering queue processing monitoring mode`);
                }
                
                await new Promise(resolve => setTimeout(resolve, 10000)); // 10 second intervals  
                continue; // Stay in the monitoring loop
                
            case 'queue-assigned':
                updateStatus(`Active queue room confirmed - transitioning to queue monitoring...`);
                console.log(`[${taskId}] Queue assigned detected - transitioning to main queue monitoring`);
                return { isQueuePage: true, pageType: pageState.pageType };
                
            case 'regular-page':
                consecutiveRegularPageDetections++;
                const minDetectionsBeforeStabilityCheck = isUsingProxy ? 3 : 2;
                
                if (consecutiveRegularPageDetections < minDetectionsBeforeStabilityCheck) {
                    updateStatus(`Regular page detected (${consecutiveRegularPageDetections}/${minDetectionsBeforeStabilityCheck}) - waiting before stability checks...`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    continue;
                }
                
                updateStatus('Regular page confirmed multiple times - performing stability checks...');
                
                let stableCount = 0;
                let stabilityCheckFailed = false;
                
                for (let i = 0; i < 3; i++) {
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    
                    // Check activity paused during stability checks
                    try {
                        const stabilityActivityCheck = await checkActivityPausedWithRetry(page, taskId, updateStatus, browserIndex);
                        if (stabilityActivityCheck.isActivityPaused && stabilityActivityCheck.shouldClose) {
                            return { shouldClose: true, status: 'Unusual activity detected' };
                        }
                    } catch (error) {
                        if (error.message.includes('Browser manually closed') ||
                            error.message.includes('Browser connection lost')) {
                            return { shouldClose: true, status: error.message };
                        }
                    }
                    
                    try {
                        const stabilityPageData = await waitForPageStable(page, taskId, updateStatus, browserIndex);
                        const checkState = await detectQueuePageType(page, taskId);
                        
                        if (checkState.pageState === 'regular-page') {
                            stableCount++;
                            updateStatus(`Stability check ${stableCount}/3 - still regular page`);
                        } else {
                            updateStatus(`Page changed during stability check - restarting analysis`);
                            consecutiveRegularPageDetections = 0;
                            stabilityCheckFailed = true;
                            break;
                        }
                    } catch (error) {
                        if (error.message.includes('Browser manually closed') ||
                            error.message.includes('Browser connection lost')) {
                            return { shouldClose: true, status: error.message };
                        }
                        
                        updateStatus(`Error during stability check: ${error.message}`);
                        return { shouldClose: true, status: `Error: ${error.message}` };
                    }
                }
                
                if (!stabilityCheckFailed && stableCount === 3) {
                    updateStatus('Not a ticketmaster queue page');
                    return { shouldClose: true, status: 'Not a ticketmaster queue page' };
                }
                
                break;
                
            default:
                updateStatus('Unknown page state - continuing monitoring...');
                consecutiveRegularPageDetections = 0;
                await new Promise(resolve => setTimeout(resolve, 5000));
                break;
        }
    }
    
    updateStatus('Pre-queue monitoring timeout reached (5 minutes)');
    console.log(`[${taskId}] Smart page monitoring timeout reached after 5 minutes`);
    return { shouldClose: true, status: 'Pre-queue timeout - sale may not have started' };
}



// Monitor individual page function without global timeout
async function monitorPage(browser, link, taskId, proxy, browserIndex) {
    let page = null;
    let currentStatus = '';
    
    // Track this task's browser assignment
    taskToBrowserMap.set(taskId, browserIndex);
    
    const updateStatus = (status) => {
        if (status !== currentStatus) {
            currentStatus = status;
            console.log(`Task ${taskId}: ${status}`);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('task-update', {
                    taskId: taskId,
                    status: status
                });
            }
        }
    };
    
    try {
        updateStatus('Loading page...');
        page = await browser.newPage();
        
        // Set up proxy authentication if provided
        if (proxy && proxy.username && proxy.password) {
            await page.authenticate({
                username: proxy.username,
                password: proxy.password
            });
        }
        
        // Block unnecessary resources
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                req.abort();
            } else {
                req.continue();
            }
        });
        
        // Navigate with timeout
        const timeout = proxy ? 90000 : 60000;
        await page.goto(link, {
            waitUntil: 'load',
            timeout: timeout
        });
        
        updateStatus('Page loaded, starting smart monitoring...');
        
        // Check if using proxy
        const isUsingProxy = proxy && proxy.host && proxy.port;
        
        // Start smart page monitoring
        const monitoringResult = await smartPageMonitoring(page, taskId, updateStatus, isUsingProxy, browserIndex);
        
        if (monitoringResult.shouldClose) {
            return {
                taskId: taskId,
                link: link,
                status: monitoringResult.status,
                success: false
            };
        }
        
        if (monitoringResult.isQueuePage) {
            updateStatus('Starting enhanced queue monitoring...');
            
            // Main monitoring loop for queue pages with transition detection
            let monitoringActive = true;
            let lastPageType = null;
            let waitingRoomTimeout = null;
            
            // Set up transition monitoring for real-time detection
            const onTransition = async () => {
                try {
                    const pageState = await detectQueuePageType(page, taskId);
                    if (pageState.isQueuePage && pageState.pageType !== lastPageType) {
                        console.log(`[${taskId}] 🔄 Page transition detected: ${lastPageType} → ${pageState.pageType}`);
                        lastPageType = pageState.pageType;
                        
                        // Handle transition immediately
                        if (pageState.pageType === 'queue-assigned') {
                            const queueNumber = await extractQueueNumber(page, taskId);
                            if (queueNumber) {
                                updateStatus(`Queue Number: ${queueNumber}`);
                                monitoringActive = false;
                                return {
                                    taskId: taskId,
                                    link: link,
                                    status: `Queue Number: ${queueNumber}`,
                                    queueNumber: queueNumber,
                                    success: true
                                };
                            }
                        }
                    }
                } catch (error) {
                    console.error(`[${taskId}] Error in transition handler:`, error.message);
                }
            };
            
            while (monitoringActive && !page.isClosed()) {
                try {
                    // Check activity paused during queue monitoring
                    let queueActivityCheck;
                    try {
                        queueActivityCheck = await checkActivityPausedWithRetry(page, taskId, updateStatus, browserIndex);
                    } catch (error) {
                        if (error.message.includes('Browser manually closed') ||
                            error.message.includes('Browser connection lost')) {
                            return {
                                taskId: taskId,
                                link: link,
                                status: error.message,
                                success: false
                            };
                        }
                    }
                    
                    if (queueActivityCheck.isActivityPaused && queueActivityCheck.shouldClose) {
                        return {
                            taskId: taskId,
                            link: link,
                            status: 'Unusual activity detected',
                            success: false
                        };
                    }
                    
                    // Get page content with navigation error handling
                    let pageData;
                    try {
                        pageData = await waitForPageStable(page, taskId, updateStatus, browserIndex);
                    } catch (error) {
                        if (error.message.includes('Browser manually closed') ||
                            error.message.includes('Browser connection lost')) {
                            return {
                                taskId: taskId,
                                link: link,
                                status: error.message,
                                success: false
                            };
                        }
                        
                        updateStatus(`Error reading queue content: ${error.message}`);
                        return {
                            taskId: taskId,
                            link: link,
                            status: `Error: ${error.message}`,
                            success: false
                        };
                    }
                    
                    const pageState = await detectQueuePageType(page, taskId);
                    
                    if (!pageState.isQueuePage) {
                        updateStatus('Page changed to non-queue');
                        break;
                    }
                    
                    switch (pageState.pageType) {
                        case 'waiting-room':
                            if (lastPageType !== 'waiting-room') {
                                updateStatus('Waiting room detected - monitoring for transitions...');
                                lastPageType = 'waiting-room';
                                
                                // Set up real-time transition monitoring
                                await setupPageTransitionMonitoring(page, taskId, onTransition);
                                
                                const countdownSeconds = parseCountdown(pageData.content);
                                if (countdownSeconds !== null) {
                                    const totalWaitTime = (countdownSeconds + 60) * 1000;
                                    updateStatus(`Waiting room - countdown: ${countdownSeconds}s (waiting ${Math.round(totalWaitTime/1000)}s total)`);
                                    
                                    waitingRoomTimeout = setTimeout(() => {
                                        updateStatus('Countdown completed but no transition detected');
                                        monitoringActive = false;
                                    }, totalWaitTime);
                                } else {
                                    updateStatus('Waiting room detected - monitoring for transitions...');
                                }
                            }
                            break;
                            
                        case 'queue-processing':
                            if (lastPageType !== 'queue-processing') {
                                updateStatus('Queue processing - monitoring for transitions...');
                                lastPageType = 'queue-processing';
                                
                                // Set up real-time transition monitoring
                                await setupPageTransitionMonitoring(page, taskId, onTransition);
                                
                                if (waitingRoomTimeout) {
                                    clearTimeout(waitingRoomTimeout);
                                    waitingRoomTimeout = null;
                                }
                            }
                            break;
                            
                        case 'queue-assigned':
                            const queueNumber = await extractQueueNumber(page, taskId);
                            if (queueNumber) {
                                updateStatus(`Queue Number: ${queueNumber}`);
                                
                                if (waitingRoomTimeout) {
                                    clearTimeout(waitingRoomTimeout);
                                    waitingRoomTimeout = null;
                                }
                                
                                // Clean up transition monitoring
                                if (page.transitionInterval) {
                                    clearInterval(page.transitionInterval);
                                }
                                
                                return {
                                    taskId: taskId,
                                    link: link,
                                    status: `Queue Number: ${queueNumber}`,
                                    queueNumber: queueNumber,
                                    success: true
                                };
                            }
                            break;
                            
                        default:
                            if (lastPageType !== 'unknown-queue') {
                                updateStatus('Queue page detected - analyzing...');
                                lastPageType = 'unknown-queue';
                            }
                            break;
                    }
                    
                    const waitTime = (pageState.pageType === 'queue-processing') ? 3000 : 5000;
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    
                } catch (contentError) {
                    if (isBrowserConnectionError(contentError)) {
                        const status = getBrowserClosureStatus(browserIndex, 'Browser connection lost during queue monitoring');
                        return {
                            taskId: taskId,
                            link: link,
                            status: status,
                            success: false
                        };
                    }
                    
                    console.error(`Task ${taskId}: Queue monitoring error:`, contentError.message);
                    const errorStatus = `Error: ${contentError.message}`;
                    updateStatus(errorStatus);
                    return {
                        taskId: taskId,
                        link: link,
                        status: errorStatus,
                        success: false
                    };
                }
            }
            
            return {
                taskId: taskId,
                link: link,
                status: lastPageType === 'waiting-room' ? 'Countdown timeout reached' : 'Queue monitoring ended',
                success: false
            };
        }
        
    } catch (error) {
        if (isBrowserConnectionError(error)) {
            const status = getBrowserClosureStatus(browserIndex, 'Browser connection lost');
            return {
                taskId: taskId,
                link: link,
                status: status,
                success: false
            };
        }
        
        console.error(`Task ${taskId}: Major error:`, error.message);
        const errorStatus = `Error: ${error.message}`;
        updateStatus(errorStatus);
        return {
            taskId: taskId,
            link: link,
            status: errorStatus,
            success: false
        };
        
    } finally {
        // Clean up transition monitoring
        if (page && page.transitionInterval) {
            clearInterval(page.transitionInterval);
        }
        
        // Fast close page with timeout
        if (page && !page.isClosed()) {
            try {
                await Promise.race([
                    page.close(),
                    new Promise(resolve => setTimeout(resolve, 3000))
                ]);
            } catch (closeError) {
                console.error(`Task ${taskId}: Error closing page:`, closeError.message);
            }
        }
    }
}

// Launch browser with proper manual vs program closure tracking
async function launchBrowserWithTasks(links, taskStartId, proxy, browserIndex, windowOffset) {
    let browser = null;
    let browserDisconnected = false;
    
    const updateBrowserStatus = (status) => {
        console.log(`Browser ${browserIndex}: ${status}`);
    };
    
    try {
        updateBrowserStatus('Launching browser...');
        
        // Browser launch arguments
        const browserArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--disable-default-apps',
            '--disable-extensions',
            '--disable-plugins',
            `--window-position=${windowOffset.x},${windowOffset.y}`
        ];
        
        // Add proxy configuration if provided
        if (proxy && proxy.host && proxy.port) {
            browserArgs.push(`--proxy-server=${proxy.host}:${proxy.port}`);
            console.log(`Browser ${browserIndex}: Using proxy ${proxy.host}:${proxy.port}`);
        }
        
        browser = await puppeteer.launch({
            headless: false,
            args: browserArgs,
            defaultViewport: { width: 1280, height: 720 },
            timeout: 30000
        });
        
        // Handle browser disconnection with proper manual vs program closure detection
        browser.on('disconnected', () => {
            console.log(`Browser ${browserIndex} disconnected`);
            browserDisconnected = true;
            
            // Only mark as manual if program didn't close it
            if (!programClosedBrowsers.has(browserIndex)) {
                console.log(`Browser ${browserIndex} was MANUALLY closed`);
                manuallyClosedBrowsers.add(browserIndex);
                
                // Update all tasks in this browser as manually closed
                links.forEach((link, index) => {
                    const taskId = taskStartId + index;
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('task-update', {
                            taskId: taskId,
                            status: 'Browser manually closed'
                        });
                    }
                });
            } else {
                console.log(`Browser ${browserIndex} was closed by program`);
            }
            
            // Remove from active browsers immediately
            activeBrowsers = activeBrowsers.filter(b => b.browserIndex !== browserIndex);
            
            // Clean up IP mapping
            browserIPMap.delete(browserIndex);
        });
        
        activeBrowsers.push({ browser, browserIndex });
        
        updateBrowserStatus('Browser launched, detecting IP...');
        
        // Initialize browser IP as "Detecting..."
        browserIPMap.set(browserIndex, 'Detecting...');
        updateTasksIPForBrowser(browserIndex, 'Detecting...');
        
        // Start IP detection and task processing in parallel
        const ipDetectionPromise = detectBrowserIP(browser, browserIndex).catch(error => {
            if (isBrowserConnectionError(error)) {
                const status = getBrowserClosureStatus(browserIndex, 'IP detection failed - browser connection lost');
                console.log(`Browser ${browserIndex}: ${status}`);
                return status;
            }
            throw error;
        });
        
        // Start processing tasks with improved error handling
        const taskPromises = links.map((link, index) => {
            const taskId = taskStartId + index;
            return monitorPage(browser, link, taskId, proxy, browserIndex).catch(error => {
                if (isBrowserConnectionError(error)) {
                    const status = getBrowserClosureStatus(browserIndex, 'Browser connection lost');
                    return {
                        taskId: taskId,
                        link: link,
                        status: status,
                        success: false
                    };
                }
                throw error;
            });
        });
        
        // Wait for all tasks to complete (IP detection runs independently)
        const taskResults = await Promise.all(taskPromises);
        
        // Only wait for IP detection if browser wasn't manually closed
        if (!browserDisconnected) {
            await ipDetectionPromise;
        }
        
        updateBrowserStatus(`Completed ${taskResults.length} tasks`);
        return taskResults;
        
    } catch (error) {
        updateBrowserStatus(`Browser launch failed: ${error.message}`);
        
        // Update all assigned tasks with browser launch failure
        const failedResults = links.map((link, index) => {
            const taskId = taskStartId + index;
            const failureStatus = `Browser launch failed: ${error.message}`;
            
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('task-update', {
                    taskId: taskId,
                    status: failureStatus
                });
            }
            
            return {
                taskId: taskId,
                link: link,
                status: failureStatus,
                success: false
            };
        });
        
        // Try to launch replacement browser
        try {
            updateBrowserStatus('Attempting to launch replacement browser...');
            await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay
            return await launchBrowserWithTasks(links, taskStartId, proxy, browserIndex + 100, windowOffset);
        } catch (replacementError) {
            updateBrowserStatus(`Replacement browser also failed: ${replacementError.message}`);
            return failedResults;
        }
        
    } finally {
        // Use fast close only if browser wasn't manually closed
        if (browser && !browserDisconnected) {
            try {
                await fastClose(null, browser, browserIndex, 3000);
                activeBrowsers = activeBrowsers.filter(b => b.browserIndex !== browserIndex);
                updateBrowserStatus('Browser closed');
            } catch (closeError) {
                console.error(`Error closing browser ${browserIndex}:`, closeError.message);
            }
        } else if (browserDisconnected) {
            updateBrowserStatus('Browser disconnection handled');
        }
        
        // Clean up tracking when browser processing is complete
        manuallyClosedBrowsers.delete(browserIndex);
        programClosedBrowsers.delete(browserIndex);
    }
}

// Continuous browser processing with robust disconnection handling
async function processBrowserContinuously(links, tabsPerBrowser, maxBrowsers, proxyList) {
    const allResults = [];
    let currentTaskId = 1;
    let linkIndex = 0;
    let browserIndex = 1;
    let activeBrowserCount = 0;
    const activeBrowserPromises = new Map();
    
    console.log(`Starting continuous browser processing - ${links.length} links, ${tabsPerBrowser} tabs per browser, max ${maxBrowsers} concurrent browsers`);
    console.log(`Proxy rotation: ${proxyList.length} proxies available`);
    
    // Helper function to start a new browser
    const startNewBrowser = async () => {
        if (linkIndex >= links.length || activeBrowserCount >= maxBrowsers) {
            return;
        }
        
        const browserLinks = links.slice(linkIndex, linkIndex + tabsPerBrowser);
        if (browserLinks.length === 0) {
            return;
        }
        
        const currentBrowserIndex = browserIndex++;
        const currentTaskStartId = currentTaskId;
        
        // Get next proxy in rotation
        const assignedProxy = getNextProxy(proxyList);
        
        linkIndex += browserLinks.length;
        currentTaskId += browserLinks.length;
        activeBrowserCount++;
        
        const windowOffset = {
            x: 100 + ((currentBrowserIndex - 1) % maxBrowsers) * 100,
            y: 100 + ((currentBrowserIndex - 1) % maxBrowsers) * 100
        };
        
        console.log(`Starting browser ${currentBrowserIndex} with ${browserLinks.length} links (tasks ${currentTaskStartId}-${currentTaskStartId + browserLinks.length - 1}) using proxy ${assignedProxy ? assignedProxy.index : 'none'}`);
        
        // Add 5-second delay between browser launches (except first)
        if (activeBrowserCount > 1) {
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
        const browserPromise = launchBrowserWithTasks(browserLinks, currentTaskStartId, assignedProxy, currentBrowserIndex, windowOffset)
            .then(results => {
                console.log(`Browser ${currentBrowserIndex} completed with ${results.length} results`);
                allResults.push(...results);
                activeBrowserCount--;
                activeBrowserPromises.delete(currentBrowserIndex);
                
                // Start next browser immediately
                setImmediate(() => startNewBrowser());
                return results;
            })
            .catch(error => {
                console.error(`Browser ${currentBrowserIndex} failed:`, error);
                
                // Handle browser closure gracefully with proper status
                if (isBrowserConnectionError(error)) {
                    const status = getBrowserClosureStatus(currentBrowserIndex, 'Browser connection lost');
                    console.log(`Browser ${currentBrowserIndex}: ${status}`);
                    
                    // Mark tasks with appropriate status
                    const connectionLostResults = browserLinks.map((link, index) => ({
                        taskId: currentTaskStartId + index,
                        link: link,
                        status: status,
                        success: false
                    }));
                    allResults.push(...connectionLostResults);
                } else {
                    // Other errors - mark as failed
                    const errorResults = browserLinks.map((link, index) => ({
                        taskId: currentTaskStartId + index,
                        link: link,
                        status: `Browser error: ${error.message}`,
                        success: false
                    }));
                    allResults.push(...errorResults);
                }
                
                activeBrowserCount--;
                activeBrowserPromises.delete(currentBrowserIndex);
                
                // Start next browser even if this one failed
                setImmediate(() => startNewBrowser());
                return [];
            });
        
        activeBrowserPromises.set(currentBrowserIndex, browserPromise);
    };
    
    // Start initial browsers up to maxBrowsers
    const initialBrowsers = Math.min(maxBrowsers, Math.ceil(links.length / tabsPerBrowser));
    for (let i = 0; i < initialBrowsers; i++) {
        await startNewBrowser();
    }
    
    // Wait for all browsers to complete
    while (activeBrowserPromises.size > 0) {
        await Promise.race(activeBrowserPromises.values());
    }
    
    console.log(`Continuous processing complete. ${allResults.filter(r => r.success).length} successful, ${allResults.filter(r => !r.success).length} failed`);
    return allResults;
}

// Main queue monitoring handler with multi-proxy support
ipcMain.handle('run-queue', async (event, { links, concurrency, tabsPerBrowser, maxBrowsers, proxyList }) => {
    console.log('Starting multi-browser queue monitoring with proxy rotation');
    console.log('Total links:', links.length);
    console.log('Concurrency:', concurrency);
    console.log('Tabs per browser:', tabsPerBrowser);
    console.log('Max concurrent browsers:', maxBrowsers);
    console.log('Proxy list:', proxyList ? `${proxyList.length} proxies` : 'No proxies');
    
    // Validation
    if (concurrency % tabsPerBrowser !== 0) {
        throw new Error(`Concurrency (${concurrency}) must be divisible by Tabs per Browser (${tabsPerBrowser})`);
    }
    
    const browsersNeeded = Math.ceil(concurrency / tabsPerBrowser);
    if (browsersNeeded > maxBrowsers) {
        throw new Error(`Need ${browsersNeeded} browsers but max concurrent browsers is set to ${maxBrowsers}`);
    }
    
    // Parse proxy list
    const parsedProxyList = proxyList && proxyList.length > 0 ? parseProxyList(proxyList.join('\n')) : [];
    console.log(`Parsed ${parsedProxyList.length} valid proxies`);
    
    // Reset proxy rotation index and closure tracking
    proxyRotationIndex = 0;
    manuallyClosedBrowsers.clear();
    programClosedBrowsers.clear();
    isProcessing = true;
    activeBrowsers = [];
    browserIPMap.clear();
    taskToBrowserMap.clear();
    
    try {
        // Use continuous browser processing with proxy rotation
        const allResults = await processBrowserContinuously(links, tabsPerBrowser, maxBrowsers, parsedProxyList);
        
        return {
            results: allResults,
            failedLinks: allResults.filter(r => !r.success).map(r => r.link)
        };
        
    } catch (error) {
        console.error('Continuous browser processing error:', error);
        throw new Error('Failed to process queue: ' + error.message);
    } finally {
        // Cleanup any remaining browsers with fast close
        for (const { browser, browserIndex } of activeBrowsers) {
            try {
                await fastClose(null, browser, browserIndex, 3000);
            } catch (e) {
                console.error('Error closing browser during cleanup:', e.message);
            }
        }
        
        activeBrowsers = [];
        browserIPMap.clear();
        taskToBrowserMap.clear();
        manuallyClosedBrowsers.clear();
        programClosedBrowsers.clear();
        isProcessing = false;
    }
});

// NEW: Generate Queue Links handler with integrated CAPTCHA solving
ipcMain.handle('generate-queue-links', async (event, { eventUrl, numBrowsers, proxyList }) => {
    console.log('Starting Generate Queue Links with integrated CAPTCHA solving');
    console.log('Event URL:', eventUrl);
    console.log('Number of browsers:', numBrowsers);
    console.log('Proxy list:', proxyList ? `${proxyList.length} proxies` : 'No proxies');

    const results = [];
    let activeBrowsers = [];
    let taskToPageMap = new Map();
    let generatedQueueLinks = [];

    // Parse proxy list
    const parsedProxyList = proxyList && proxyList.length > 0 ? parseProxyList(proxyList.join('\n')) : [];
    let proxyIndex = 0;

    // Helper function to get next proxy
    const getNextProxy = () => {
        if (parsedProxyList.length === 0) return null;
        const proxy = parsedProxyList[proxyIndex % parsedProxyList.length];
        proxyIndex++;
        return proxy;
    };

    // Launch browser for each task
    const launchBrowserForTask = async (taskId) => {
        let browser = null;
        let page = null;
        
        try {
            // Get proxy for this browser
            const proxy = getNextProxy();

            // Update status
            mainWindow.webContents.send('generate-update', {
                taskId: taskId,
                status: 'Launching browser...'
            });

            // Browser launch arguments
            const browserArgs = [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor',
                '--disable-dev-shm-usage',
                '--no-first-run',
                '--disable-default-apps',
                '--disable-extensions',
                '--disable-plugins',
                `--window-position=${100 + (taskId * 50)},${100 + (taskId * 50)}`
            ];

            // Add proxy configuration if available
            if (proxy && proxy.host && proxy.port) {
                browserArgs.push(`--proxy-server=${proxy.host}:${proxy.port}`);
                console.log(`Task ${taskId}: Using proxy ${proxy.host}:${proxy.port}`);
            }

            browser = await puppeteer.launch({
                headless: false,
                args: browserArgs,
                defaultViewport: { width: 1280, height: 720 },
                timeout: 30000
            });

            activeBrowsers.push({ browser, taskId });

            // Create new page
            page = await browser.newPage();
            taskToPageMap.set(taskId, page);

            // Set up proxy authentication if provided
            if (proxy && proxy.username && proxy.password) {
                await page.authenticate({
                    username: proxy.username,
                    password: proxy.password
                });
            }

            // Block unnecessary resources
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const resourceType = req.resourceType();
                if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            // Detect IP and update GUI
            try {
                const ip = await detectBrowserIP(browser, taskId);
                mainWindow.webContents.send('generate-ip-update', {
                    browserIndex: taskId,
                    ip: ip
                });
            } catch (ipError) {
                console.error(`Task ${taskId}: IP detection failed:`, ipError.message);
            }

            // Update status
            mainWindow.webContents.send('generate-update', {
                taskId: taskId,
                status: 'Loading event page...'
            });

            // Navigate to event URL
            await page.goto(eventUrl, {
                waitUntil: 'load',
                timeout: 60000
            });

            // Check for CAPTCHA
            mainWindow.webContents.send('generate-update', {
                taskId: taskId,
                status: 'Checking for CAPTCHA...'
            });

            const hasCaptcha = await isCaptchaPageLoaded(page);

            if (hasCaptcha) {
                console.log(`Task ${taskId}: CAPTCHA detected`);
                
                // Try OCR first
                const ocrSolved = await solveCaptchaWithOCR(page, taskId);
                
                if (ocrSolved) {
                    // OCR succeeded, extract queue link
                    const queueLink = await extractQueueLink(page, taskId);
                    
                    if (queueLink) {
                        generatedQueueLinks.push(queueLink);
                        
                        mainWindow.webContents.send('generate-update', {
                            taskId: taskId,
                            status: 'Queue link generated!',
                            queueLink: queueLink
                        });
                        
                        console.log(`Task ${taskId}: Successfully generated queue link: ${queueLink}`);
                    } else {
                        mainWindow.webContents.send('generate-update', {
                            taskId: taskId,
                            status: 'CAPTCHA solved but queue link not found'
                        });
                    }
                } else {
                    // OCR failed, CAPTCHA image already sent to renderer for manual input
                    console.log(`Task ${taskId}: Waiting for manual CAPTCHA input`);
                }
            } else {
                // No CAPTCHA, try to extract queue link directly
                mainWindow.webContents.send('generate-update', {
                    taskId: taskId,
                    status: 'No CAPTCHA - extracting queue link...'
                });
                
                const queueLink = await extractQueueLink(page, taskId);
                
                if (queueLink) {
                    generatedQueueLinks.push(queueLink);
                    
                    mainWindow.webContents.send('generate-update', {
                        taskId: taskId,
                        status: 'Queue link generated!',
                        queueLink: queueLink
                    });
                    
                    console.log(`Task ${taskId}: Successfully generated queue link: ${queueLink}`);
                } else {
                    mainWindow.webContents.send('generate-update', {
                        taskId: taskId,
                        status: 'No queue link found'
                    });
                }
            }

        } catch (error) {
            console.error(`Task ${taskId}: Browser launch failed:`, error.message);
            mainWindow.webContents.send('generate-update', {
                taskId: taskId,
                status: `Error: ${error.message}`
            });
        }
    };

    // Launch all browsers
    const browserPromises = [];
    for (let i = 1; i <= numBrowsers; i++) {
        browserPromises.push(launchBrowserForTask(i));
        // Add delay between browser launches
        if (i < numBrowsers) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    // Wait for all browsers to launch
    await Promise.all(browserPromises);

    // Store browser references for CAPTCHA submission
    global.generateTaskToPageMap = taskToPageMap;
    global.generateActiveBrowsers = activeBrowsers;
    global.generateQueueLinks = generatedQueueLinks;

    return {
        success: true,
        message: `${numBrowsers} browsers launched for queue link generation`,
        activeTasks: numBrowsers,
        queueLinks: generatedQueueLinks
    };
});

// Handle manual CAPTCHA submission (when OCR fails)
ipcMain.handle('submit-captcha', async (event, { taskId, captchaCode }) => {
    try {
        const page = global.generateTaskToPageMap?.get(taskId);
        if (!page) {
            throw new Error('Page not found for task');
        }

        console.log(`Task ${taskId}: Submitting manual CAPTCHA: ${captchaCode}`);

        // Update status
        mainWindow.webContents.send('generate-update', {
            taskId: taskId,
            status: 'Submitting manual CAPTCHA...'
        });

        // Clear existing text and type CAPTCHA
        await page.click('input[name="CaptchaCode"]');
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.type('input[name="CaptchaCode"]', captchaCode);

        // Click submit button
        await page.click('button.botdetect-button');

        // Wait for page to process
        await page.waitForNavigation({ 
            waitUntil: 'networkidle2', 
            timeout: 15000 
        });

        // Update status
        mainWindow.webContents.send('generate-update', {
            taskId: taskId,
            status: 'CAPTCHA submitted - extracting queue link...'
        });

        // Try to extract queue link after CAPTCHA submission
        const queueLink = await extractQueueLink(page, taskId);
        
        if (queueLink) {
            global.generateQueueLinks.push(queueLink);
            
            mainWindow.webContents.send('generate-update', {
                taskId: taskId,
                status: 'Queue link generated!',
                queueLink: queueLink
            });
            
            return { success: true, queueLink: queueLink };
        } else {
            mainWindow.webContents.send('generate-update', {
                taskId: taskId,
                status: 'CAPTCHA submitted but queue link not found'
            });
            
            return { success: true, message: 'CAPTCHA submitted but queue link not found' };
        }

    } catch (error) {
        console.error(`Task ${taskId}: Manual CAPTCHA submission failed:`, error.message);
        
        mainWindow.webContents.send('generate-update', {
            taskId: taskId,
            status: `CAPTCHA submission failed: ${error.message}`
        });
        
        return { success: false, message: error.message };
    }
});

// Get all generated queue links
ipcMain.handle('get-generated-queue-links', async () => {
    return global.generateQueueLinks || [];
});

// Stop all processing
ipcMain.handle('stop-all', async () => {
    console.log('Stopping all processing...');
    
    try {
        isProcessing = false;
        
        // Close all active browsers with fast close
        for (const { browser, browserIndex } of activeBrowsers) {
            try {
                await fastClose(null, browser, browserIndex, 3000);
            } catch (e) {
                console.error('Error closing browser during stop:', e.message);
            }
        }
        
        // Close generate queue links browsers
        if (global.generateActiveBrowsers) {
            for (const { browser, taskId } of global.generateActiveBrowsers) {
                try {
                    await fastClose(null, browser, taskId, 3000);
                } catch (e) {
                    console.error('Error closing generate browser during stop:', e.message);
                }
            }
        }
        
        // Clear all tracking
        activeBrowsers = [];
        browserIPMap.clear();
        taskToBrowserMap.clear();
        manuallyClosedBrowsers.clear();
        programClosedBrowsers.clear();
        
        // Clear generate queue links tracking
        global.generateTaskToPageMap = new Map();
        global.generateActiveBrowsers = [];
        global.generateQueueLinks = [];
        
        return { success: true, message: 'All processing stopped' };
        
    } catch (error) {
        console.error('Error stopping all processing:', error);
        return { success: false, error: error.message };
    }
});

// Get current processing status
ipcMain.handle('get-status', async () => {
    return {
        isProcessing: isProcessing,
        activeBrowsers: activeBrowsers.length,
        browserIPMap: Object.fromEntries(browserIPMap),
        taskToBrowserMap: Object.fromEntries(taskToBrowserMap)
    };
});

// Initialize global variables for Generate Queue Links
global.generateTaskToPageMap = new Map();
global.generateActiveBrowsers = [];
global.generateQueueLinks = [];

console.log('Ticketmaster Queue Monitor with CAPTCHA solving ready');

