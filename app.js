const connectBtn = document.getElementById('connectBtn');
const getVersionBtn = document.getElementById('getVersionBtn');
const readCardBtn = document.getElementById('readCardBtn');
const writeCardBtn = document.getElementById('writeCardBtn');
const formatCardBtn = document.getElementById('formatCardBtn');
const scanAgainBtn = document.getElementById('scanAgainBtn');
const dataTableBody = document.querySelector('#dataTable tbody');
const statusElement = document.getElementById('status');
const firmwareInfoElement = document.getElementById('firmwareInfo');
const cardOperationsElement = document.getElementById('cardOperations');
const cardTypeInfoElement = document.getElementById('cardTypeInfo');

// PN532 Commands
const WAKEUP_COMMAND = new Uint8Array([0x55, 0x55, 0x00, 0x00, 0x00]);
const SAM_CONFIG_COMMAND = new Uint8Array([
    0x00, 0x00, 0xFF, // Preamble
    0x05, 0xFB,       // Start code & length
    0xD4, 0x14,       // TFI & Command
    0x01,             // Normal mode
    0x00,             // No timeout
    0x00,             // No IRQ
    0x32, 0x00        // Checksum
]);
const READ_UID_COMMAND = new Uint8Array([
    0x00, 0x00, 0xFF, // Preamble
    0x04, 0xFC,       // Start code & length
    0xD4, 0x4A,       // TFI & Command (InListPassiveTarget)
    0x01,             // Max targets (1)
    0x00,             // Baud rate (106 kbps type A)
    0xE1, 0x00        // Checksum
]);
const GET_FIRMWARE_VERSION_COMMAND = new Uint8Array([
    0x00, 0x00, 0xFF, // Preamble
    0x02, 0xFE,       // Start code & length
    0xD4, 0x02,       // TFI & Command (GetFirmwareVersion)
    0x2A, 0x00        // Checksum
]);

// MIFARE Commands
const MIFARE_AUTH_CMD = 0x60; // Key A Authentication
const MIFARE_READ_CMD = 0x30; // Read block
const MIFARE_WRITE_CMD = 0xA0; // Write block

let port;
let reader;
let isPolling = false;
let currentCardUID = null;
let currentCardType = null;
let isAwaitingResponse = false;
let responseCallback = null;

// Initialize DOM elements after window loads
window.addEventListener('DOMContentLoaded', () => {
    console.log('DOM fully loaded');
    
    // Re-query elements to ensure they're available
    const elementsCheck = [
        { name: 'dataTableBody', element: document.querySelector('#dataTable tbody') },
        { name: 'statusElement', element: document.getElementById('status') },
        { name: 'cardOperationsElement', element: document.getElementById('cardOperations') },
        { name: 'cardTypeInfoElement', element: document.getElementById('cardTypeInfo') }
    ];
    
    elementsCheck.forEach(item => {
        if (!item.element) {
            console.error(`Element ${item.name} not found`);
        } else {
            console.log(`Found element ${item.name}`);
            // Update global variables if needed
            if (item.name === 'dataTableBody') dataTableBody = item.element;
            if (item.name === 'statusElement') statusElement = item.element;
            if (item.name === 'cardOperationsElement') cardOperationsElement = item.element;
            if (item.name === 'cardTypeInfoElement') cardTypeInfoElement = item.element;
        }
    });
    
    // Initialize status display
    updateStatus('Ready. Click "Connect to PN532" to begin.');
});

function updateStatus(message) {
    if (statusElement) {
        statusElement.textContent = message;
        console.log('Status:', message);
    } else {
        console.error('Status element not found');
        // Try to re-acquire the status element
        const element = document.getElementById('status');
        if (element) {
            statusElement = element;
            statusElement.textContent = message;
            console.log('Re-acquired status element and updated message:', message);
        } else {
            console.error('Could not find status element');
        }
    }
}

function hexToBytes(hex) {
    let bytes = [];
    for (let c = 0; c < hex.length; c += 2)
        bytes.push(parseInt(hex.substr(c, 2), 16));
    return bytes;
}

function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

// Calculate checksum for PN532 commands
function calculateChecksum(data) {
    let sum = 0;
    // Skip preamble bytes
    for (let i = 3; i < data.length - 2; i++) {
        sum += data[i];
    }
    // Calculate two's complement
    let checksum = (-sum) & 0xFF;
    return checksum;
}

// Setup connect button event handler after DOM load
window.addEventListener('DOMContentLoaded', () => {
    const connectButton = document.getElementById('connectBtn');
    if (connectButton) {
        connectButton.addEventListener('click', handleConnectButtonClick);
        console.log('Connect button listener set up');
    } else {
        console.error('Connect button not found');
    }
});

async function handleConnectButtonClick() {
    console.log('Connect button clicked, port state:', port ? 'connected' : 'disconnected');
    
    if (port) {
        // Disconnect if already connected
        try {
            isPolling = false;
            isAwaitingResponse = false;
            if (reader) {
                await reader.cancel();
                reader.releaseLock();
                reader = null;
            }
            await port.close();
            port = null;
            
            // Update UI
            const connectButton = document.getElementById('connectBtn');
            if (connectButton) connectButton.textContent = 'Connect to PN532';
            
            const versionButton = document.getElementById('getVersionBtn');
            if (versionButton) versionButton.disabled = true;
            
            updateStatus('Disconnected.');
            
            if (firmwareInfoElement) firmwareInfoElement.style.display = 'none';
            if (cardOperationsElement) cardOperationsElement.style.display = 'none';
            
            currentCardUID = null;
            
            // Add disconnect event to table
            addRow('Disconnected from PN532');
        } catch (err) {
            console.error('Disconnect error:', err);
            updateStatus(`Disconnect error: ${err.message || err}`);
        }
        return;
    }

    try {
        updateStatus('Requesting serial port access...');
        
        // Add connection attempt to table
        addRow('Connecting to PN532...');
        
        port = await navigator.serial.requestPort();
        await port.open({ baudRate: 115200 }); // Typical for PN532 UART
        
        // Update UI
        const connectButton = document.getElementById('connectBtn');
        if (connectButton) connectButton.textContent = 'Disconnect';
        
        const versionButton = document.getElementById('getVersionBtn');
        if (versionButton) versionButton.disabled = false;
        
        updateStatus('Connected to PN532. Initializing...');

        // Initialize PN532
        await initializePN532();
        
        // Add connection success to table
        addRow('Connected to PN532');

        // Don't start continuous polling
        // Instead wait for user to click a scan button or version button
    } catch (err) {
        updateStatus(`Error: ${err.message || err}`);
        console.error('Connection error:', err);
        
        // Add error to table
        addRow(`Connection error: ${err.message || err}`);
    }
}

// Setup version button handler after DOM load
window.addEventListener('DOMContentLoaded', () => {
    const versionButton = document.getElementById('getVersionBtn');
    if (versionButton) {
        versionButton.addEventListener('click', handleGetVersionClick);
        console.log('Version button listener set up');
    } else {
        console.error('Version button not found');
    }
});

async function handleGetVersionClick() {
    if (!port) {
        updateStatus('Not connected to PN532');
        return;
    }
    
    console.log('Get Version button clicked');
    try {
        updateStatus('Getting firmware version...');
        
        // Add version request to table
        addRow('Requesting firmware version...');
        
        const firmwareData = await sendCommandAndWaitForResponse(GET_FIRMWARE_VERSION_COMMAND);
        if (firmwareData) {
            parseFirmwareVersion(firmwareData);
        } else {
            updateStatus('Failed to get firmware version');
            addRow('Failed to get firmware version');
        }
    } catch (err) {
        updateStatus(`Error getting firmware version: ${err.message || err}`);
        addRow(`Firmware version error: ${err.message || err}`);
    }
}

// Setup card operation button handlers after DOM load
window.addEventListener('DOMContentLoaded', () => {
    // Read card button
    const readButton = document.getElementById('readCardBtn');
    if (readButton) {
        readButton.addEventListener('click', handleReadCardClick);
        console.log('Read button listener set up');
    } else {
        console.error('Read button not found');
    }
    
    // Write card button
    const writeButton = document.getElementById('writeCardBtn');
    if (writeButton) {
        writeButton.addEventListener('click', handleWriteCardClick);
        console.log('Write button listener set up');
    } else {
        console.error('Write button not found');
    }
    
    // Format card button
    const formatButton = document.getElementById('formatCardBtn');
    if (formatButton) {
        formatButton.addEventListener('click', handleFormatCardClick);
        console.log('Format button listener set up');
    } else {
        console.error('Format button not found');
    }
});

async function handleReadCardClick() {
    if (!port || !currentCardUID) {
        updateStatus('No card detected or not connected');
        return;
    }
    
    console.log('Read Card button clicked');
    try {
        if (currentCardType === 'MIFARE Classic' || currentCardType === 'MIFARE Ultralight') {
            updateStatus(`Reading ${currentCardType} card...`);
            await readMifareCard();
        } else {
            updateStatus(`Reading not supported for ${currentCardType || 'unknown'} cards yet`);
            addRow(`Reading not supported for ${currentCardType || 'unknown'} cards yet`);
        }
    } catch (err) {
        updateStatus(`Error reading card: ${err.message || err}`);
        addRow(`Error reading card: ${err.message || err}`);
    }
}

async function handleWriteCardClick() {
    if (!port || !currentCardUID) {
        updateStatus('No card detected or not connected');
        return;
    }
    
    console.log('Write Card button clicked');
    try {
        if (currentCardType === 'MIFARE Classic' || currentCardType === 'MIFARE Ultralight') {
            updateStatus(`Writing to ${currentCardType} card...`);
            await writeMifareCard();
        } else {
            updateStatus(`Writing not supported for ${currentCardType || 'unknown'} cards yet`);
            addRow(`Writing not supported for ${currentCardType || 'unknown'} cards yet`);
        }
    } catch (err) {
        updateStatus(`Error writing to card: ${err.message || err}`);
        addRow(`Error writing to card: ${err.message || err}`);
    }
}

async function handleFormatCardClick() {
    if (!port || !currentCardUID) {
        updateStatus('No card detected or not connected');
        return;
    }
    
    console.log('Format Card button clicked');
    if (confirm(`Are you sure you want to format the ${currentCardType} card? This will erase all data.`)) {
        try {
            updateStatus(`Formatting ${currentCardType} card...`);
            await formatMifareCard();
        } catch (err) {
            updateStatus(`Error formatting card: ${err.message || err}`);
            addRow(`Error formatting card: ${err.message || err}`);
        }
    }
}

// Scan again button
// Ensure event listeners are set up after DOM is fully loaded
window.addEventListener('DOMContentLoaded', () => {
    // Scan Again button setup
    const scanAgainButton = document.getElementById('scanAgainBtn');
    if (scanAgainButton) {
        scanAgainButton.addEventListener('click', handleScanAgain);
        console.log('Scan Again button listener set up');
    } else {
        console.error('Scan Again button not found');
    }
});

async function handleScanAgain() {
    if (!port) return;
    
    console.log('Scan Again button clicked');
    currentCardUID = null;
    if (cardOperationsElement) {
        cardOperationsElement.style.display = 'none';
    }
    updateStatus('Scanning for cards...');
    await scanForCard();
    
    // Add a table entry to show scan was triggered
    addRow('Scanning for new card...');
}

async function initializePN532() {
    try {
        const writer = port.writable.getWriter();
        
        // Send wake up command
        await writer.write(WAKEUP_COMMAND);
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Configure SAM (Security Access Module)
        await writer.write(SAM_CONFIG_COMMAND);
        await new Promise(resolve => setTimeout(resolve, 50));
        
        writer.releaseLock();
        
        // Start reading responses
        startReading();
        
        updateStatus('PN532 initialized successfully. Click "Get Firmware Version" or scan for a card.');
    } catch (err) {
        updateStatus(`Initialization error: ${err.message || err}`);
        console.error('Init error:', err);
    }
}

async function startReading() {
    if (reader) {
        try {
            await reader.cancel();
        } catch (e) {
            console.log('Error canceling previous reader:', e);
        }
        reader.releaseLock();
    }
    
    reader = port.readable.getReader();
    readResponseLoop();
}

async function readResponseLoop() {
    const decoder = new TextDecoder();
    let buffer = '';
    
    try {
        while (port && reader) {
            const { value, done } = await reader.read();
            if (done) {
                updateStatus('Reader disconnected');
                break;
            }
            
            if (value && value.length > 0) {
                // Process response
                const hexData = bytesToHex(value);
                console.log('Received data:', hexData);
                
                // Always add raw data to the console for debugging
                console.log('Raw data length:', value.length, 'HEX:', hexData);
                
                if (isAwaitingResponse && responseCallback) {
                    responseCallback(value);
                    isAwaitingResponse = false;
                    responseCallback = null;
                } else {
                    // Process as card response if not awaiting a specific response
                    processCardResponse(value);
                }
                
                // Also check for text-based responses
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed) {
                        console.log('Text line:', trimmed);
                        // If this looks like card data, add it to the table
                        if (trimmed.includes('Card detected:') || 
                            /\d{2}(\s+\d{2})+/.test(trimmed)) { // Pattern like "04 68 ff 42..."
                            addRow(`Text data: ${trimmed}`);
                        }
                    }
                }
            }
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            updateStatus(`Read error: ${err.message || err}`);
            console.error('Read error:', err);
            // Try to recover by restarting the reader
            setTimeout(() => {
                if (port) {
                    try {
                        startReading();
                        updateStatus('Restarted reader after error');
                    } catch (e) {
                        console.error('Failed to restart reader:', e);
                    }
                }
            }, 1000);
        }
    }
}

async function sendCommandAndWaitForResponse(command, timeout = 3000) {
    return new Promise((resolve, reject) => {
        (async () => {
            try {
                if (isAwaitingResponse) {
                    reject(new Error('Already awaiting another response'));
                    return;
                }
                
                isAwaitingResponse = true;
                responseCallback = (response) => {
                    clearTimeout(timeoutId);
                    resolve(response);
                };
                
                const timeoutId = setTimeout(() => {
                    isAwaitingResponse = false;
                    responseCallback = null;
                    reject(new Error('Response timeout'));
                }, timeout);
                
                const writer = port.writable.getWriter();
                await writer.write(command);
                writer.releaseLock();
            } catch (err) {
                isAwaitingResponse = false;
                responseCallback = null;
                reject(err);
            }
        })();
    });
}

function processCardResponse(data) {
    // Try multiple parsing approaches to handle different PN532 formats
    let cardFound = false;
    let foundUidHex = null;
    let foundSak = null;
    let foundUidLength = null;
    
    // Method 1: Look for standard PN532 response format
    try {
        if (data.length >= 12) {
            // Check if this looks like a card detection response
            if (data[5] === 0xD5 && data[6] === 0x4B) {
                // This is a response to InListPassiveTarget command
                const status = data[7]; // Status byte
                if (status === 0x01) {
                    // Card detected
                    // Card ATQA (Answer To Request Type A)
                    const atqa = (data[9] << 8) | data[10];
                    // SAK (Select Acknowledge)
                    const sak = data[11];
                    
                    const uidLength = data[12]; // Length of UID
                    if (data.length >= 13 + uidLength) {
                        const uid = data.slice(13, 13 + uidLength);
                        const uidHex = bytesToHex(uid);
                        
                        cardFound = true;
                        foundUidHex = uidHex;
                        foundSak = sak;
                        foundUidLength = uidLength;
                        
                        console.log("Found card with UID:", uidHex, "SAK:", sak, "UID Length:", uidLength);
                        // Don't identify yet, continue checking all methods
                    }
                }
            }
        }
    } catch (e) {
        console.log('Error in standard parsing:', e);
    }

    // Method 2: Just check if the data looks like a 4-7 byte UID
    try {
        if (!cardFound && data.length >= 4 && data.length <= 10) {
            const uidHex = bytesToHex(data);
            console.log("Method 2: Possible card UID detected:", uidHex);
            
            // If no better detection from method 1, use this
            if (!cardFound) {
                cardFound = true;
                foundUidHex = uidHex;
                // Use default values for SAK and length
                foundSak = 0;
                foundUidLength = data.length;
            }
        }
    } catch (e) {
        console.log('Error in simple parsing:', e);
    }
    
    // Method 3: Direct string matching for patterns in hex data
    try {
        if (!cardFound) {
            const hexString = bytesToHex(data);
            // Look for patterns like "04 68 ff 42 e3 73 80" in the data
            const cardPattern = /\b([0-9a-f]{2}\s){3,9}[0-9a-f]{2}\b/i;  // Match 4-10 bytes
            const match = hexString.match(cardPattern);
            if (match) {
                console.log("Method 3: Matched card pattern:", match[0]);
                
                // If no better detection, use this
                if (!cardFound) {
                    cardFound = true;
                    foundUidHex = match[0];
                    // Use default values for SAK and length
                    foundSak = 0;
                    foundUidLength = match[0].split(' ').length;
                }
            }
        }
    } catch (e) {
        console.log('Error in pattern parsing:', e);
    }
    
    // Raw data debugging - add every response to table to see patterns
    const hexDump = bytesToHex(data);
    if (hexDump && hexDump.length > 0) {
        console.log("Raw data received:", hexDump);
        // Add raw data to table for debugging
        addRow(`Raw data: ${hexDump}`);
    }
    
    // Process found card
    if (cardFound && foundUidHex) {
        console.log("Processing card with UID:", foundUidHex);
        if (foundSak !== null && foundUidLength !== null) {
            identifyCardType(foundSak, foundUidLength, foundUidHex);
        } else {
            handleCardDetection(foundUidHex);
        }
    }
}

function identifyCardType(sak, uidLength, uidHex) {
    let cardType = 'Unknown';
    let canRead = false;
    let canWrite = false;
    let canFormat = false;
    
    // Identify card type based on SAK value and UID length
    // SAK values from NXP documentation
    if ((sak & 0x08) === 0x08) {
        // MIFARE Classic compatible
        if (uidLength === 4) {
            cardType = 'MIFARE Classic 1K';
            canRead = true;
            canWrite = true;
            canFormat = true;
        } else if (uidLength === 7) {
            cardType = 'MIFARE Classic 4K';
            canRead = true;
            canWrite = true;
            canFormat = true;
        }
    } else if ((sak & 0x20) === 0x20) {
        // MIFARE DESFire or SmartMX with MIFARE emulation
        cardType = 'MIFARE DESFire';
        canRead = false;  // Requires authentication
        canWrite = false; // Requires authentication
        canFormat = false;
    } else if (sak === 0x00) {
        // MIFARE Ultralight or NTAG
        cardType = 'MIFARE Ultralight/NTAG';
        canRead = true;
        canWrite = true;
        canFormat = true;
    } else if (sak === 0x20) {
        cardType = 'MIFARE Plus';
        canRead = false;  // Requires authentication
        canWrite = false; // Requires authentication
        canFormat = false;
    }
    
    handleCardDetection(uidHex, cardType, { canRead, canWrite, canFormat });
}

function handleCardDetection(uidHex, cardType = 'Unknown', capabilities = { canRead: false, canWrite: false, canFormat: false }) {
    // Always add data to the table, even if it's the same card
    // This ensures the table is updated with every detection
    const cardInfo = `${uidHex} (${cardType})`;
    console.log("Adding card to table:", cardInfo);
    addRow(cardInfo);
    
    // Only update the UI state if this is a new card or if we're scanning again
    if (uidHex !== currentCardUID || currentCardUID === null) {
        currentCardUID = uidHex;
        currentCardType = cardType;
        
        updateStatus(`Card detected: ${uidHex} (${cardType})`);
        
        // Show card operations panel
        cardOperationsElement.style.display = 'block';
        cardTypeInfoElement.textContent = `Card Type: ${cardType} (UID: ${uidHex})`;
        
        // Enable/disable buttons based on capabilities
        readCardBtn.disabled = !capabilities.canRead;
        writeCardBtn.disabled = !capabilities.canWrite;
        formatCardBtn.disabled = !capabilities.canFormat;
        
        // Stop polling after detecting a card
        isPolling = false;
    }
}

async function scanForCard() {
    if (!port) return;
    
    try {
        const writer = port.writable.getWriter();
        await writer.write(READ_UID_COMMAND);
        writer.releaseLock();
    } catch (err) {
        updateStatus(`Scan error: ${err.message || err}`);
    }
}

async function readMifareCard() {
    // Implementation would depend on card type
    // For demonstration purposes:
    updateStatus('Reading card data (operation not fully implemented yet)');
    addRow(`Read operation on ${currentCardType} card`);
    
    // Here you would:
    // 1. Select the card using its UID
    // 2. Authenticate with key A or B
    // 3. Read blocks and interpret data
}

async function writeMifareCard() {
    // Implementation would depend on card type
    // For demonstration purposes:
    updateStatus('Writing data to card (operation not fully implemented yet)');
    addRow(`Write operation on ${currentCardType} card`);
    
    // Here you would:
    // 1. Select the card using its UID
    // 2. Authenticate with key A or B
    // 3. Write data to blocks
}

async function formatMifareCard() {
    // Implementation would depend on card type
    // For demonstration purposes:
    updateStatus('Formatting card (operation not fully implemented yet)');
    addRow(`Format operation on ${currentCardType} card`);
    
    // Here you would:
    // 1. Select the card using its UID
    // 2. Authenticate with key A or B
    // 3. Write default values to all blocks
}

function parseFirmwareVersion(response) {
    try {
        // Check for correct response format
        if (response.length >= 10 && response[5] === 0xD5 && response[6] === 0x03) {
            const ic = response[7];
            const version = response[8];
            const revision = response[9];
            const support = response[10];
            
            let icName;
            switch (ic) {
                case 0x32:
                    icName = 'PN532';
                    break;
                case 0x33:
                    icName = 'PN533';
                    break;
                default:
                    icName = `Unknown (0x${ic.toString(16)})`;
            }
            
            const firmwareInfo = `IC: ${icName}, Version: ${version}.${revision}, Support: 0x${support.toString(16)}`;
            updateStatus(`Firmware version retrieved: ${firmwareInfo}`);
            
            // Display firmware info in the designated element
            firmwareInfoElement.textContent = firmwareInfo;
            firmwareInfoElement.style.display = 'block';
            
            addRow(`Firmware: ${firmwareInfo}`);
        } else {
            updateStatus('Invalid firmware version response');
        }
    } catch (e) {
        updateStatus(`Error parsing firmware version: ${e.message || e}`);
    }
}

function addRow(data) {
    console.log('Adding row to table:', data);
    
    // Make sure dataTableBody element exists
    if (!dataTableBody) {
        console.error('dataTableBody element not found');
        const tableBody = document.querySelector('#dataTable tbody');
        if (tableBody) {
            console.log('Found table body with querySelector');
            dataTableBody = tableBody;
        } else {
            console.error('Could not find table body element');
            return;
        }
    }
    
    // Create row and cells
    const row = document.createElement('tr');
    const tsCell = document.createElement('td');
    const dataCell = document.createElement('td');
    
    // Set content
    tsCell.textContent = new Date().toLocaleString();
    dataCell.textContent = data;
    
    // Add cells to row
    row.appendChild(tsCell);
    row.appendChild(dataCell);
    
    // Insert at the top
    try {
        if (dataTableBody.firstChild) {
            dataTableBody.insertBefore(row, dataTableBody.firstChild);
        } else {
            dataTableBody.appendChild(row);
        }
        console.log('Successfully added row to table');
    } catch (err) {
        console.error('Error adding row to table:', err);
    }
}
