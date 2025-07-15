const connectBtn = document.getElementById('connectBtn');
const dataTableBody = document.querySelector('#dataTable tbody');
const statusElement = document.getElementById('status');

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

let port;
let reader;
let isPolling = false;
let lastCardUID = null; // Track the last card detected to avoid duplicates

// Initialize status display
updateStatus('Ready. Click "Connect to PN532" to begin.');

function updateStatus(message) {
    if (statusElement) {
        statusElement.textContent = message;
        console.log('Status:', message);
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

connectBtn.addEventListener('click', async () => {
    if (port) {
        // Disconnect if already connected
        try {
            isPolling = false;
            if (reader) {
                await reader.cancel();
                reader.releaseLock();
            }
            await port.close();
            port = null;
            connectBtn.textContent = 'Connect to PN532';
            updateStatus('Disconnected.');
        } catch (err) {
            console.error('Disconnect error:', err);
        }
        return;
    }

    try {
        updateStatus('Requesting serial port access...');
        port = await navigator.serial.requestPort();
        await port.open({ baudRate: 115200 }); // Typical for PN532 UART
        connectBtn.textContent = 'Disconnect';
        updateStatus('Connected to PN532. Initializing...');

        // Initialize PN532
        await initializePN532();

        // Start polling for cards
        isPolling = true;
        pollForCards();
    } catch (err) {
        updateStatus(`Error: ${err.message || err}`);
        console.error('Connection error:', err);
    }
});

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
        
        updateStatus('PN532 initialized successfully');
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
                
                // Try both binary processing and text processing
                processCardResponse(value);
                
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
                            addRow(trimmed);
                        }
                    }
                }
            }
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            updateStatus(`Read error: ${err.message || err}`);
            console.error('Read error:', err);
        }
    }
}

function processCardResponse(data) {
    // Try multiple parsing approaches to handle different PN532 formats
    
    // Method 1: Look for standard PN532 response format
    try {
        if (data.length >= 12) {
            // Check if this looks like a card detection response
            if (data[5] === 0xD5 && data[6] === 0x4B) {
                // This is a response to InListPassiveTarget command
                const status = data[7]; // Status byte
                if (status === 0x01) {
                    // Card detected
                    const uidLength = data[12]; // Length of UID
                    if (data.length >= 13 + uidLength) {
                        const uid = data.slice(13, 13 + uidLength);
                        const uidHex = bytesToHex(uid);
                        handleCardDetection(uidHex);
                    }
                }
            }
        }
    } catch (e) {
        console.log('Error in standard parsing:', e);
    }

    // Method 2: Just check if the data looks like a card UID
    try {
        // Check if the data looks like a 7-byte UID (like in your screenshot)
        if (data.length === 7) {
            const uidHex = bytesToHex(data);
            handleCardDetection(uidHex);
        }
    } catch (e) {
        console.log('Error in simple parsing:', e);
    }
    
    // Method 3: Direct string matching for the pattern seen in the screenshot
    try {
        const hexString = bytesToHex(data);
        // Look for patterns like "04 68 ff 42 e3 73 80" in the data
        const cardPattern = /\b([0-9a-f]{2}\s){6}[0-9a-f]{2}\b/i;
        const match = hexString.match(cardPattern);
        if (match) {
            handleCardDetection(match[0]);
        }
    } catch (e) {
        console.log('Error in pattern parsing:', e);
    }
}

function handleCardDetection(uidHex) {
    // Avoid duplicate readings in quick succession
    if (uidHex !== lastCardUID) {
        lastCardUID = uidHex;
        updateStatus(`Card detected: ${uidHex}`);
        addRow(uidHex);
        
        // Reset last card after a delay to allow re-reading the same card
        setTimeout(() => {
            if (lastCardUID === uidHex) {
                lastCardUID = null;
            }
        }, 1500);
    }
}

async function pollForCards() {
    while (isPolling && port) {
        try {
            const writer = port.writable.getWriter();
            await writer.write(READ_UID_COMMAND);
            writer.releaseLock();
            
            // Wait a moment before polling again
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (err) {
            updateStatus(`Polling error: ${err.message || err}`);
            console.error('Poll error:', err);
            isPolling = false;
            break;
        }
    }
}

function addRow(data) {
    console.log('Adding row to table:', data);
    const row = document.createElement('tr');
    const tsCell = document.createElement('td');
    const dataCell = document.createElement('td');
    tsCell.textContent = new Date().toLocaleString();
    dataCell.textContent = data;
    row.appendChild(tsCell);
    row.appendChild(dataCell);
    
    // Insert at the top
    if (dataTableBody.firstChild) {
        dataTableBody.insertBefore(row, dataTableBody.firstChild);
    } else {
        dataTableBody.appendChild(row);
    }
}
