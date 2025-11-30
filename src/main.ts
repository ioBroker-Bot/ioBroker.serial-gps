import { Adapter, type AdapterOptions } from '@iobroker/adapter-core'; // Get common adapter utils
import { SerialPort } from 'serialport';
import type { SerialGpsAdapterConfig } from './types';

function verifyChecksum(sentence: string): boolean {
    const asterisk = sentence.indexOf('*');
    if (asterisk === -1) {
        return true;
    } // no checksum present -> accept
    const payload = sentence.substring(0, asterisk);
    const chkStr = sentence.substring(asterisk + 1).trim();
    let chk = 0;
    for (let i = 0; i < payload.length; i++) {
        chk ^= payload.charCodeAt(i);
    }
    const hex = chk.toString(16).toUpperCase().padStart(2, '0');
    return hex === chkStr.toUpperCase();
}

function nmeaToDecimal(coord: string, hemi: string): number | null {
    if (!coord) {
        return null;
    }

    const dot = coord.indexOf('.');
    if (dot === -1) {
        return null;
    } // kein Dezimalpunkt -> ungültig

    // für N/S sind die Grad 2 Stellen, für E/W 3 Stellen
    const degLen = hemi === 'N' || hemi === 'S' ? 2 : 3;

    if (coord.length <= degLen) {
        return null;
    } // nicht genug Zeichen

    const degStr = coord.substring(0, degLen);
    const minStr = coord.substring(degLen); // enthält Minuten + Dezimalteil

    const deg = parseInt(degStr, 10);
    const min = parseFloat(minStr);

    if (isNaN(deg) || isNaN(min)) {
        return null;
    }

    let val = deg + min / 60;
    if (hemi === 'S' || hemi === 'W') {
        val = -val;
    }
    return val;
}

export class IotAdapter extends Adapter {
    declare config: SerialGpsAdapterConfig;
    private serialPort?: SerialPort;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private lastStates = new Map<string, { val: any; ts: number }>();
    private recvBuffer = '';

    public constructor(options: Partial<AdapterOptions> = {}) {
        super({
            ...options,
            name: 'serial-gps',
            unload: async callback => {
                if (this.reconnectTimer) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                }
                await this.closePort();
                callback();
            },
            message: async obj => {
                // read all serial ports and give them back to GUI
                if (obj) {
                    switch (obj.command) {
                        case 'list':
                            if (obj.callback) {
                                try {
                                    // read all found serial ports
                                    const ports = await SerialPort.list();
                                    this.log.info(`List of port: ${JSON.stringify(ports)}`);
                                    this.sendTo(
                                        obj.from,
                                        obj.command,
                                        ports.map(item => ({
                                            label: item.path,
                                            value: item.path,
                                        })),
                                        obj.callback,
                                    );
                                } catch (e) {
                                    this.log.error(`Cannot list ports: ${e}`);
                                    this.sendTo(
                                        obj.from,
                                        obj.command,
                                        [{ label: 'Not available', value: '' }],
                                        obj.callback,
                                    );
                                }
                            }

                            break;

                        case 'detectBaudRate':
                            if (obj.callback) {
                                try {
                                    const baudRate = await this.detectBaudRate(obj.message.serialPort);
                                    if (baudRate) {
                                        this.sendTo(obj.from, obj.command, { native: { baudRate } }, obj.callback);
                                    } else {
                                        this.sendTo(
                                            obj.from,
                                            obj.command,
                                            { error: 'Cannot detect baud rate' },
                                            obj.callback,
                                        );
                                    }
                                } catch (e) {
                                    this.sendTo(
                                        obj.from,
                                        obj.command,
                                        [{ label: 'Not available', value: '' }],
                                        obj.callback,
                                    );
                                }
                            }

                            break;

                        case 'test':
                            if (obj.callback) {
                                try {
                                    const result = await this.test(obj.message.serialPort, obj.message.baudRate);
                                    this.sendTo(
                                        obj.from,
                                        obj.command,
                                        {
                                            result: result ? 'GPS Receiver detected' : 'GPS Receiver not detected',
                                            error: !result ? 'GPS Receiver not detected' : undefined,
                                        },
                                        obj.callback,
                                    );
                                } catch (e) {
                                    this.sendTo(
                                        obj.from,
                                        obj.command,
                                        { error: `Test failed: ${e.message || e}` },
                                        obj.callback,
                                    );
                                }
                            }
                            break;
                    }
                }
            },
            ready: () => this.main(),
        });
    }

    private async test(port: string, baudRate: string | number): Promise<boolean> {
        let portClosed = false;
        if (this.config.serialPort === port) {
            portClosed = true;
            await this.closePort();
        }
        const result = await this.testPort(port, baudRate);
        if (portClosed) {
            await this.openPort();
        }
        return result;
    }

    private async testPort(port: string, baudRate: number | string): Promise<boolean> {
        this.log.info(`Testing port ${port} with baud rate ${baudRate}`);
        const testPort = new SerialPort({
            path: port,
            baudRate: parseInt(baudRate as string, 10),
            autoOpen: false,
        });
        await new Promise<void>((resolve, reject) => {
            testPort.open(err => {
                if (err) {
                    this.log.error(`Failed to open serial port ${port} at ${baudRate}: ${err.message || err}`);
                    reject(err);
                    return;
                }
                this.log.info(`Serial port opened for testing: ${port} @ ${baudRate}`);
                resolve();
            });
        });

        let receivedData = false;
        let receiveBuffer = '';
        const dataListener = (data: Buffer) => {
            receiveBuffer += data.toString('utf8');
            this.log.info(`Received data at baud rate ${baudRate}: ${receiveBuffer}`);
            // try to detect specific NMEA sentence starts
            if (
                receiveBuffer.includes('$GPGGA') ||
                receiveBuffer.includes('$GPRMC') ||
                receiveBuffer.includes('$GNGGA') ||
                receiveBuffer.includes('$GNRMC')
            ) {
                receivedData = true;
            }
        };
        testPort.on('data', dataListener);

        // Wait up to 5 seconds for data
        await new Promise<void>(resolve => setTimeout(() => resolve(), 3000));

        testPort.off('data', dataListener);
        await new Promise<void>(resolve => {
            testPort.close(err => {
                if (err) {
                    this.log.error(`Error closing test port: ${err.message || err}`);
                }
                this.log.info(`Test serial port closed: ${port} @ ${baudRate}`);
                resolve();
            });
        });

        if (receivedData) {
            this.log.info(`Detected baud rate: ${baudRate}`);
            return true;
        }
        return false;
    }

    private async detectBaudRate(port: string): Promise<number> {
        let portClosed = false;
        if (this.config.serialPort === port) {
            portClosed = true;
            await this.closePort();
        }
        const baudRatesToTest = [4800, 9600, 19200, 38400, 57600, 115200];
        for (const baudRate of baudRatesToTest) {
            this.log.info(`Testing baud rate: ${baudRate}`);
            if (await this.testPort(port, baudRate)) {
                if (portClosed) {
                    await this.openPort();
                }
                return baudRate;
            }
        }
        this.log.warn(`Could not detect baud rate for port: ${port}`);
        if (portClosed) {
            await this.openPort();
        }
        return 0;
    }

    private closePort(): Promise<void> {
        if (this.serialPort) {
            return new Promise(resolve => {
                try {
                    if (this.serialPort!.isOpen) {
                        this.serialPort!.close(err => {
                            if (err) {
                                this.log.error(`Error closing serial port: ${err.message || err}`);
                            }
                            this.log.info('Serial port closed');
                            resolve();
                        });
                        return;
                    }
                } catch (e) {
                    this.log.warn(`Error while closing port: ${(e as Error).message || e}`);
                }
                this.serialPort = undefined;
                resolve();
            });
        }
        return Promise.resolve();
    }

    private async setStateIfChangedAsync(id: string, value: ioBroker.StateValue): Promise<void> {
        const now = Date.now();
        const prev = this.lastStates.get(id);
        const changed = !prev || value !== prev.val;
        if (!changed && prev && now - prev.ts < 60000) {
            // unchanged and not older than 60s -> skip
            return;
        }
        this.lastStates.set(id, { val: value, ts: now });
        await this.setStateAsync(id, value, true);
    }

    private async parseData(text: string): Promise<void> {
        // Split by '$' because some devices send multiple sentences in one chunk (sentences start with $)
        const parts = text
            .split('$')
            .map(p => p.trim())
            .filter(p => p.length > 0);

        for (const raw of parts) {
            const sentence = raw.startsWith('$') ? raw : `$${raw}`;
            // remove any trailing characters beyond checksum
            const s = sentence.replace(/\r?\n/g, '').trim();
            if (!s.startsWith('$')) {
                continue;
            }
            const body = s.slice(1); // without leading $
            if (!verifyChecksum(body)) {
                this.log.warn(`NMEA checksum mismatch: ${s}`);
                continue;
            }

            const asteriskIdx = body.indexOf('*');
            const payload = asteriskIdx >= 0 ? body.substring(0, asteriskIdx) : body;
            const fields = payload.split(',');
            const type = fields[0];

            try {
                if (type.endsWith('GGA')) {
                    // $--GGA,time,lat,NS,lon,EW,fix,numSat,hdop,alt,altUnit,...
                    const lat = nmeaToDecimal(fields[2], fields[3]);
                    const lon = nmeaToDecimal(fields[4], fields[5]);
                    const fix = parseInt(fields[6], 10) || 0;
                    const sats = parseInt(fields[7], 10) || 0;
                    const hdop = parseFloat(fields[8]) || 0;
                    const alt = parseFloat(fields[9]) || 0;

                    if (lat !== null && lon !== null) {
                        await this.setStateIfChangedAsync('gps.latitude', lat);
                        await this.setStateIfChangedAsync('gps.longitude', lon);
                        await this.setStateIfChangedAsync('gps.position', `${lon};${lat}`);
                        await this.setStateIfChangedAsync('gps.latlon', `${lat};${lon}`);
                        this.log.debug(`GGA parsed: lat=${lat}, lon=${lon}`);
                    }
                    await this.setStateIfChangedAsync('gps.satellites', sats);
                    await this.setStateIfChangedAsync('gps.hdop', hdop);
                    await this.setStateIfChangedAsync('gps.altitude', alt);

                    const connected = fix > 0;
                    await this.setStateIfChangedAsync('info.connection', connected);
                } else if (type.endsWith('RMC')) {
                    // $--RMC,time,status,lat,NS,lon,EW,sog,cog,date,...
                    const status = fields[2]; // A=active, V=void
                    const lat = nmeaToDecimal(fields[3], fields[4]);
                    const lon = nmeaToDecimal(fields[5], fields[6]);
                    const speedKnots = parseFloat(fields[7]) || 0;
                    const course = parseFloat(fields[8]) || 0;

                    if (lat !== null && lon !== null) {
                        await this.setStateIfChangedAsync('gps.latitude', lat);
                        await this.setStateIfChangedAsync('gps.longitude', lon);
                        this.log.debug(`RMC parsed: lat=${lat}, lon=${lon}`);
                    }
                    // convert knots to km/h
                    const speedKmh = +(speedKnots * 1.852).toFixed(2);
                    await this.setStateIfChangedAsync('gps.speed', speedKmh);
                    await this.setStateIfChangedAsync('gps.course', course);

                    const connected = status === 'A';
                    await this.setStateIfChangedAsync('info.connection', connected);
                } else {
                    // other sentence types can be handled if needed
                    this.log.silly(`Unhandled NMEA sentence: ${type}`);
                }
            } catch (e) {
                this.log.error(`Error parsing NMEA sentence ${s}: ${(e as Error).message}`);
            }
        }
    }

    private async openPort(): Promise<void> {
        // Close existing port if open
        await this.closePort();

        try {
            this.serialPort = new SerialPort({
                path: this.config.serialPort,
                baudRate: parseInt(this.config.baudRate as string, 10) || 9600,
                autoOpen: false,
            });

            this.serialPort.open(err => {
                if (err) {
                    this.log.error(`Failed to open serial port ${this.config.serialPort}: ${err.message || err}`);
                    return;
                }
                this.log.info(`Serial port opened: ${this.config.serialPort} @ ${this.config.baudRate}`);
            });

            this.serialPort.on('data', async (data: Buffer): Promise<void> => {
                if (this.reconnectTimer) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                }
                const chunk = data.toString('utf8');
                this.recvBuffer += chunk;

                // process complete lines only (lines end with `\n`)
                while (this.recvBuffer.indexOf('\n') !== -1) {
                    const idx = this.recvBuffer.indexOf('\n');
                    const line = this.recvBuffer.slice(0, idx + 1); // include newline
                    this.recvBuffer = this.recvBuffer.slice(idx + 1);
                    try {
                        await this.parseData(line);
                    } catch (e) {
                        this.log.error(`Error processing serial data: ${(e as Error).message || e}`);
                    }
                }
            });

            this.serialPort.on('error', (err: Error) => {
                this.log.error(`Serial port error (${this.config.serialPort}): ${err.message || err}`);
                this.setStateIfChangedAsync('info.connection', false);

                this.reconnectTimer ||= setTimeout(() => {
                    this.reconnectTimer = null;
                    this.log.info(`Reconnecting to serial port: ${this.config.serialPort}`);
                    this.openPort();
                }, 5000);
            });

            this.serialPort.on('close', () => {
                this.log.info(`Serial port closed: ${this.config.serialPort}`);
                this.setStateIfChangedAsync('info.connection', false);

                this.reconnectTimer ||= setTimeout(() => {
                    this.reconnectTimer = null;
                    this.log.info(`Reconnecting to serial port: ${this.config.serialPort}`);
                    this.openPort();
                }, 5000);
            });
        } catch (error) {
            // Cannot open port
            this.log.error(`Error parsing serial port: ${error.message || error}`);
            this.setStateIfChangedAsync('info.connection', false);
            this.reconnectTimer ||= setTimeout(() => {
                this.reconnectTimer = null;
                this.log.info(`Reconnecting to serial port: ${this.config.serialPort}`);
                this.openPort();
            }, 5000);
        }
    }

    main(): void {
        this.setState('info.connection', false, true);
        this.openPort().then(() => {});
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<AdapterOptions> | undefined) => new IotAdapter(options);
} else {
    // otherwise start the instance directly
    (() => new IotAdapter())();
}
