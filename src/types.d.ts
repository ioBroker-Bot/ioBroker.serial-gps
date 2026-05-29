export interface SerialGpsAdapterConfig {
    /** How the device is selected: by fixed port path or by stable USB device ID */
    selectBy: 'port' | 'device';
    serialPort: string;
    /** Stable USB identifier in the form `vendorId:productId:serialNumber` (used when selectBy === 'device') */
    deviceId: string;
    baudRate: number | string;
    test?: boolean;
}
