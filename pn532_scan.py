import serial
import serial.tools.list_ports
import time
import sys

# PN532 InListPassiveTarget command (ISO14443A, 1 target)
READ_UID_COMMAND = bytes([
    0x00, 0x00, 0xFF,
    0x04, 0xFC,
    0xD4, 0x4A, 0x01, 0x00,
    0xE1,
    0x00
])

def read_rfid_uid(ser):
    try:
        ser.reset_input_buffer()
        ser.write(READ_UID_COMMAND)
        time.sleep(0.3)
        response = ser.read(64)

        if len(response) < 20:
            return None

        # Parse response and extract UID
        uid_len = response[12]
        uid_bytes = response[13:13 + uid_len]
        uid_str = ' '.join(f'{b:02X}' for b in uid_bytes)
        
        # Print card type info based on SAK (Select Acknowledge) and UID length
        if len(response) >= 12:
            sak = response[11]
            card_type = get_card_type(sak, uid_len)
            print(f"Card type: {card_type}")
        
        return uid_str

    except Exception as e:
        print(f"Error reading UID: {e}")
        return None

def get_card_type(sak, uid_length):
    """Identify card type based on SAK value and UID length."""
    if (sak & 0x08) == 0x08:
        # MIFARE Classic compatible
        if uid_length == 4:
            return "MIFARE Classic 1K"
        elif uid_length == 7:
            return "MIFARE Classic 4K"
    elif (sak & 0x20) == 0x20:
        return "MIFARE DESFire or SmartMX"
    elif sak == 0x00:
        return "MIFARE Ultralight/NTAG"
    elif sak == 0x20:
        return "MIFARE Plus"
    return f"Unknown (SAK: 0x{sak:02X}, UID Length: {uid_length})"

def find_pn532_port():
    """
    Scan for available serial ports and try to find a PN532 device.
    Returns the first port that responds to PN532 commands or None if no suitable port is found.
    """
    print("Scanning for available serial ports...")
    available_ports = list(serial.tools.list_ports.comports())
    
    if not available_ports:
        print("No serial ports found.")
        return None
    
    # Print list of found ports
    print(f"Found {len(available_ports)} ports:")
    for i, port_info in enumerate(available_ports):
        print(f"{i+1}. {port_info.device} - {port_info.description}")
    
    # Try each port to find the PN532
    for port_info in available_ports:
        port = port_info.device
        print(f"\nTrying {port} ({port_info.description})...")
        
        try:
            # Try to open the port
            ser = serial.Serial(port=port, baudrate=115200, timeout=1)
            
            # Send wake command and see if we get a response
            ser.reset_input_buffer()
            # PN532 wake up command
            wake_cmd = bytes([0x55, 0x55, 0x00, 0x00, 0x00])
            ser.write(wake_cmd)
            time.sleep(0.1)
            
            # Send GetFirmwareVersion command
            firmware_cmd = bytes([
                0x00, 0x00, 0xFF, 
                0x02, 0xFE, 
                0xD4, 0x02,
                0x2A, 0x00
            ])
            ser.write(firmware_cmd)
            time.sleep(0.1)
            
            # Read response
            response = ser.read(20)
            
            # Check if response looks like a PN532 response
            if len(response) >= 10 and response[5] == 0xD5 and response[6] == 0x03:
                print(f"PN532 found on {port}!")
                ic_version = response[7]
                fw_version = response[8]
                fw_revision = response[9]
                print(f"Firmware version: {fw_version}.{fw_revision}")
                return ser  # Return the already-opened serial connection
            
            ser.close()
            print(f"No PN532 response on {port}")
            
        except Exception as e:
            print(f"Error on {port}: {e}")
    
    print("No PN532 device found on any port.")
    return None

def main():
    port = None
    ser = None
    
    # Check if port is provided as command line argument
    if len(sys.argv) >= 2:
        port = sys.argv[1]
        try:
            print(f"Trying to connect to specified port {port}...")
            ser = serial.Serial(port=port, baudrate=115200, timeout=1)
            print(f"Connected to {port}.")
        except Exception as e:
            print(f"Error opening serial port {port}: {e}")
            print("Will try to auto-detect PN532 device...")
    
    # If no port specified or connection failed, try to auto-detect
    if ser is None:
        ser = find_pn532_port()
        if ser is None:
            print("\nCould not find PN532 device. Please check connections and try again.")
            print("You can also specify the port directly: python pn532_scan.py COM5")
            sys.exit(1)
    
    print("Connected to PN532. Waiting for RFID tags...\nPress Ctrl+C to exit.\n")

    try:
        print("Scanning for a card... (will exit after successful read)")
        while True:
            uid = read_rfid_uid(ser)
            if uid:
                print(f"Card detected! UID: {uid}")
                print("Successfully read card. Exiting.")
                break  # Exit the loop after successful read
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\nExiting.")
    finally:
        ser.close()

if __name__ == "__main__":
    main()
