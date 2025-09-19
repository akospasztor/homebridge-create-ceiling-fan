import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { CreateCeilingFanPlatform } from './platform.js';
import { Mutex } from './mutex.js';
import TuyAPI, { DPSObject } from 'tuyapi';

/**
 * CreateCeilingFanAccessory: the accessory implementation for CREATE ceiling fans.
 *
 * This class contains the accessory implementation and follows the Homebridge
 * plugin development recommendations.
 *
 * #### Exposed services and characteristics
 *
 * | Service     | Characteristics                                  |
 * | ------------| ------------------------------------------------ |
 * | `Fanv2`     | `Active`, `Rotation Direction`, `Rotation Speed` |
 * | `Lightbulb` | `On`                                             |
 *
 * Note: the `Lightbulb` service is only exposed if the accessory has been
 * configured with the light option enabled.
 *
 * #### Fan rotation speed representation
 *
 * CREATE fans have speed settings ranging from `1` (lowest) to `6` (highest).
 * The HomeKit UI slider for the fan rotation speed provides a value from `1`
 * to `100` and `0` means the fan is turned off. The slider steps can be
 * configured to a desired value via the `Min Step` Characteristic. This works
 * well e.g. for Dyson devices where the speed settings ranges from `1` to `10`.
 * In this case the `Min Step` Characteristic can be configured to `10`,
 * resulting in a nice user experience where the `0` - `100` UI slider is
 * divided into 10 steps. However, this does not work well for CREATE fans with
 * 6 speed steps. In order to provide smooth user experience, the following
 * representation is implemented:
 *
 * - The UI slider is configured with the default `Min Step` Characteristic of
 *   `1`. This provides smooth and fluid user input and slider operation.
 * - The following UI slider inputs represent the different speed settings of
 *   the fan:
 *   | Device fan speed | Corresponding UI slider value | User input range on the slider |
 *   | :--------------: | :---------------------------: | :----------------------------: |
 *   |        1         |              10               |            1 - 19              |
 *   |        2         |              30               |           20 - 39              |
 *   |        3         |              50               |           40 - 59              |
 *   |        4         |              70               |           60 - 79              |
 *   |        5         |              90               |           80 - 94              |
 *   |        6         |             100               |           95 - 100             |
 *
 *  - When the user operates the slider, a debouncing timer with the value of
 *    {@link fanSetSpeedDebouncePeriod} member is set. When the timer fires, the
 *    current state of the slider value is converted to the nearest value that
 *    corresponds to the device fan speed. The purpose of the debounce timer is
 *    to provide great user experience. Without the debounce timer, every moment
 *    the user slides the finger would result in generating lots of events -
 *    making the slider jump around immediately, without waiting for the user to
 *    finish adjusting the speed.
 *
 *    ```text
 *     UI slider    │ Fan speed
 *     input value  │ value
 *     ─────────────┼──────────────
 *     ┌──────┐     │
 *     │ 100 ─┼─────┼─► Fan speed 6
 *     │      │ ▲   │
 *     │  95  ├─┘   │
 *     │  94  ├─┐   │
 *     │      │ ▼   │
 *     │  90 ─┼─────┼─► Fan speed 5
 *     │      │ ▲   │
 *     │  80  ├─┘   │
 *     │  79  ├─┐   │
 *     │      │ ▼   │
 *     │  70 ─┼─────┼─► Fan speed 4
 *     │      │ ▲   │
 *     │  60  ├─┘   │
 *     │  59  ├─┐   │
 *     │      │ ▼   │
 *     │  50 ─┼─────┼─► Fan speed 3
 *     │      │ ▲   │
 *     │  40  ├─┘   │
 *     │  39  ├─┐   │
 *     │      │ ▼   │
 *     │  30 ─┼─────┼─► Fan speed 2
 *     │      │ ▲   │
 *     │  20  ├─┘   │
 *     │  19  ├─┐   │
 *     │      │ ▼   │
 *     │  10 ─┼─────┼─► Fan speed 1
 *     │      │ ▲   │
 *     │   1  ├─┘   │
 *     │   0 ─┼─────┼─► Fan off
 *     └──────┘     │
 *    ```
 *
 * #### Fan rotation direction representation
 *
 * The rotation of the device as seen from standing below the fan follows the
 * HomeKit rotation representation.
 *
 * | Device direction raw value | HomeKit representation | Fan operation                           |
 * | -------------------------- | ---------------------- | --------------------------------------- |
 * | `forward` (default)        | Counter-clockwise      | Fan blows downwards (i.e. summer mode)  |
 * | `reverse`                  | Clockwise              | Fan blows upwards (i.e. winter mode)    |
 *
 * #### Device communication
 *
 * The fan is a Tuya-compatible device and its firmware is mildly put: not the best.
 * Among other issues, devices with these firmware are known to stop responding
 * to commands, randomly drop connection, etc (see e.g.
 * https://github.com/jasonacox/tinytuya/discussions/443 and
 * https://github.com/moifort/homebridge-create-fan/issues/18).
 *
 * To provide reliable operation via HomeKit, this plugin implements the device
 * communication the following way:
 *
 * - The device accepts one connection at a time. Therefore, a mutex with a
 *   waiting queue is used for ensuring that only one command is sent to the
 *   device at a time. For detailed description refer to: {@link Mutex}.
 * - The device state is cached. Whenever the device state is requested by
 *   HomeKit (e.g. the user opens up the Home app), the implementation
 *   immediately returns the requested value from the cache.
 * - The status of the device is periodically (defined by
 *   {@link getDeviceStatusPeriod}) queried from the device. After obtaining the
 *   device status, the device state cache as well as the HomeKit
 *   Characteristics are automatically updated.
 * - If the device fails to respond to the get status request, the polling
 *   period is reduced significantly (defined by
 *   {@link getDeviceStatusFastRetryPeriod}), so that the attempt is retried
 *   quickly.
 * - The communication with the device happens in a synchronous way, supported
 *   by the mutex queue and timeout mechanism. This seems to provide the most
 *   reliable communication with the device.
 *
 * Communication failure tends to happen when attempting to control the device
 * via HomeKit right after using the device's physical remote. The device used
 * for development & testing (CREATE Wind Calm model purchased in 2025) seemed
 * to always recover from a failed communication latest after a few retry
 * attempts.
 *
 * @see https://developers.homebridge.io/#/
 * @see [Fanv2 service type](https://developers.homebridge.io/#/service/Fanv2)
 * @see [Lightbulb service type](https://developers.homebridge.io/#/service/Lightbulb)
 */
export class CreateCeilingFanAccessory {
  private fanService: Service;
  private lightService: Service | undefined;

  private getDeviceStatusTimer: NodeJS.Timeout;
  private fanSetSpeedDebounceTimer: NodeJS.Timeout | null = null;

  private deviceCommunicator: TuyAPI;
  private mutex: Mutex;
  private isGetStatusInProgress: boolean = false;

  private readonly fanSetSpeedDebouncePeriod: number = 500;
  private readonly getDeviceStatusFastRetryPeriod: number = 1000;
  private readonly getDeviceStatusPeriod: number = 10000;
  private readonly getDeviceStatusConnectTimeout: number = 3000;
  private readonly getDeviceStatusReadTimeout: number = 1000;
  private readonly setDeviceStatusTimeout: number = 2500;

  private readonly fanRotationSpeedNormalized: readonly number[] = [10, 30, 50, 70, 90, 100];

  private state = {
    fanOn: false,
    fanSpeed: 1,
    fanRotationClockwise: false,
    lightOn: false,
    isValid: false,
  };

  /**
   * Constructor for the CreateCeilingFanAccessory object.
   *
   * @param platform  The plugin platform object.
   * @param accessory The homebridge platform accessory object.
   */
  constructor(
    private readonly platform: CreateCeilingFanPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'CREATE')
      .setCharacteristic(this.platform.Characteristic.Model, accessory.context.device.name)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.id);

    // Get the fan service if it exists, otherwise create a new service
    this.fanService =
      this.accessory.getService(this.platform.Service.Fanv2) ||
      this.accessory.addService(this.platform.Service.Fanv2);

    // Set the fan service name: this is what is displayed as the default name on the Home app
    this.fanService.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

    // Register handlers for the fan Active (On/Off) Characteristic
    this.fanService.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.handleFanActiveStateGet.bind(this))
      .onSet(this.handleFanActiveStateSet.bind(this));

    // Register handlers for the fan Rotation Speed Characteristic
    this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onGet(this.handleFanRotationSpeedGet.bind(this))
      .onSet(this.handleFanRotationSpeedSet.bind(this));

    // Set the properties of the fan RotationSpeed Characteristic
    // Note: the fan has 6 different speed settings, which cannot be divided nicely into the 0-100% range of the UI
    // slider that is displayed in the Home app. Therefore we allow the user to smoothly adjust the speed with the UI
    // slider by setting the slider step size to 1, and we re-adjust the slider (after a debouncing timeout) to the
    // value that corresponds to the fan speed (see `fanRotationSpeed` array).
    this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 1,
      });

    // Register handlers for the fan Rotation Direction Characteristic
    this.fanService.getCharacteristic(this.platform.Characteristic.RotationDirection)
      .onGet(this.handleFanRotationDirectionGet.bind(this))
      .onSet(this.handleFanRotationDirectionSet.bind(this));

    // Note: the light service is only created if the device is configured with the light option
    if ((this.accessory.context.device.hasLight === false) ||
      (this.accessory.context.device.hasLight === 'no')) {
      this.lightService =
        this.accessory.getService(this.platform.Service.Lightbulb);
      if (this.lightService) {
        this.accessory.removeService(this.lightService);
        this.platform.log.info('Stale light service has been removed');
      }
    } else if ((this.accessory.context.device.hasLight === true) ||
      (this.accessory.context.device.hasLight === 'notDimmable')) {
      // Get the light service if it exists, otherwise create a new service
      this.lightService =
        this.accessory.getService(this.platform.Service.Lightbulb) ||
        this.accessory.addService(this.platform.Service.Lightbulb);

      // Set the light service name
      this.lightService.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name + ' Light');

      // Register handlers for the light On/Off Characteristic
      this.lightService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.handleLightOnGet.bind(this))
        .onSet(this.handleLightOnSet.bind(this));
    } else {
      this.platform.log.error(
        `The "hasLight" configuration value "${this.accessory.context.device.hasLight}" is invalid. ` +
        'Please check the plugin configuration.');
    }

    // Throw a warning message about deprecated values
    if ((this.accessory.context.device.hasLight === true) ||
      (this.accessory.context.device.hasLight === false)) {
      this.platform.log.warn(
        `The "hasLight" configuration value "${this.accessory.context.device.hasLight}" is deprecated. ` +
        'Please check the plugin configuration.');
    }

    // Create the device communicator object
    this.deviceCommunicator = new TuyAPI({
      id: this.accessory.context.device.id,
      key: this.accessory.context.device.key,
      ip: this.accessory.context.device.ip,
      version: this.accessory.context.device.protocolVersion,
      issueGetOnConnect: false,
    });

    this.deviceCommunicator.on('error', (error: Error) => {
      this.platform.log.info('Error during device communication:', error);
    });

    // Create the mutex to prevent concurrent communication with the device
    this.mutex = new Mutex();

    // Start the periodic get status timer
    this.getDeviceStatusTimer = setTimeout(() => this.getDeviceStatus(), this.getDeviceStatusPeriod);

    this.platform.log.info('Accessory initialized: %s (device id: %s)',
      this.accessory.context.device.name,
      this.accessory.context.device.id,
    );
    this.platform.log.debug('Accessory details:', this.accessory.context.device);
  }

  /**
   * Handle the get requests from HomeKit to get the current value of the Fanv2 Active characteristic
   *
   * @return The Fanv2 Active characteristic value from the device state cache.
   */
  async handleFanActiveStateGet(): Promise<CharacteristicValue> {
    this.getDeviceStatus();
    this.throwErrorIfDeviceUnresponsive();
    return this.fanActiveValueToCharacteristicValue();
  }

  /**
   * Handle the set requests from HomeKit to set the device with the Fanv2 Active characteristic value
   *
   * @param value The Fanv2 Active characteristic value to be set.
   */
  async handleFanActiveStateSet(value: CharacteristicValue) {
    this.platform.log.debug('Set Fan Active:', value);
    await this.setDeviceValueWithTimeout(60, (value === this.platform.Characteristic.Active.ACTIVE) ? true : false);
  }

  /**
   * Handle the get requests from HomeKit to get the current value of the Fanv2 Rotation Speed characteristic
   *
   * @return The Fanv2 Rotation Speed characteristic value from the device state cache.
   */
  async handleFanRotationSpeedGet(): Promise<CharacteristicValue> {
    this.getDeviceStatus();
    this.throwErrorIfDeviceUnresponsive();
    return this.fanRotationSpeedValueToCharacteristicValue();
  }

  /**
   * Handle the set requests from HomeKit to set the device with the Fanv2 Rotation Speed characteristic value
   *
   * @param value The Fanv2 Rotation Speed characteristic value to be set.
   */
  async handleFanRotationSpeedSet(value: CharacteristicValue) {
    this.platform.log.debug('Set RotationSpeed input:', value);

    const adjustedValue = this.adjustInputRotationSpeed(Number(value));

    // Stop any existing debounce timer
    if (this.fanSetSpeedDebounceTimer) {
      clearTimeout(this.fanSetSpeedDebounceTimer);
    }

    if (adjustedValue !== 0) {
      this.fanService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, adjustedValue);
      this.platform.log.debug('Set RotationSpeed adjusted:', adjustedValue);

      // Start a new debounce timer
      this.fanSetSpeedDebounceTimer = setTimeout(async () => {
        const dpsRotationSpeed = this.fanRotationSpeedNormalized.indexOf(adjustedValue) + 1;
        this.platform.log.debug('Set RotationSpeed debounced, setting DPS value:', dpsRotationSpeed);
        await this.setDeviceValueWithTimeout(62, dpsRotationSpeed);
      }, this.fanSetSpeedDebouncePeriod);
    }
  }

  /**
   * Handle the get requests from HomeKit to get the current value of the Fanv2 Rotation Direction characteristic
   *
   * @return The Fanv2 Rotation Direction characteristic value from the device state cache.
   */
  async handleFanRotationDirectionGet(): Promise<CharacteristicValue> {
    this.getDeviceStatus();
    this.throwErrorIfDeviceUnresponsive();
    return this.fanRotationDirectionValueToCharacteristicValue();
  }

  /**
   * Handle the set requests from HomeKit to set the device with the Fanv2 Rotation Direction characteristic value
   *
   * @param value The Fanv2 Rotation Direction characteristic value to be set.
   */
  async handleFanRotationDirectionSet(value: CharacteristicValue) {
    this.platform.log.debug('Set Fan RotationDirection:',
      (value === this.platform.Characteristic.RotationDirection.COUNTER_CLOCKWISE) ? 'COUNTER_CLOCKWISE' : 'CLOCKWISE');
    await this.setDeviceValueWithTimeout(63,
      (value === this.platform.Characteristic.RotationDirection.COUNTER_CLOCKWISE) ? 'forward' : 'reverse');
  }

  /**
   * Handle the get requests from HomeKit to get the current value of the Lightbulb On characteristic
   *
   * @return The Lightbulb On characteristic value from the device state cache.
   */
  async handleLightOnGet(): Promise<CharacteristicValue> {
    this.getDeviceStatus();
    this.throwErrorIfDeviceUnresponsive();
    return this.lightOnValueToCharacteristicValue();
  }

  /**
   * Handle the set requests from HomeKit to set the device with the Lightbulb On characteristic value
   *
   * @param value The Lightbulb On characteristic value to be set.
   */
  async handleLightOnSet(value: CharacteristicValue) {
    this.platform.log.debug('Set Light On:', value);
    await this.setDeviceValueWithTimeout(20, value as boolean);
  }

  /**
   * Get device status.
   *
   * This method reads the status of the device periodically and updates the
   * accessory state after completing the operation. The actual communication
   * is carried out with a timeout mechanism, so that an unresponsive device
   * will not make the plugin and HomeKit unresponsive. If the communication
   * fails, the periodic timer will be set with a shorter timeout so that the
   * next retry attempt happens fast. After the communication with the device
   * is recovered, the period will be reset to the original period value.
   *
   * The function can be called in two ways:
   *
   * 1. Calling it with `await`: the method starts the reading operation and
   *    waits (i.e. blocks) until the reading has been completed (or timed out).
   * 2. Simply calling it (without `await`): the method starts the reading
   *    operation and returns right afterwards, not waiting for the reading
   *    to be completed. This is used when handling accessory GET requests
   *    from HomeKit. Get requests should return as fast as possible, because
   *    long delays will result in HomeKit being unresponsive and a bad user
   *    experience in general.
   *
   * If the function is called again while there is already an ongoing read
   * operation, the reading will simply be skipped - the accessory status will
   * be updated anyway after executing the already ongoing reading operation.
   * This can happen e.g. when a periodic read operation is already in place
   * and a GET request arrives from HomeKit at the same time.
   */
  private async getDeviceStatus() {
    this.platform.log.debug('[getDeviceStatus] --- Start');

    let isCommunicationError = false;
    clearTimeout(this.getDeviceStatusTimer);

    if (!this.isGetStatusInProgress) {
      this.isGetStatusInProgress = true;
      const releaseMutex = await this.mutex.lock();
      this.platform.log.debug('  * Mutex granted for reading, connecting to device...');

      try {
        await this.waitForPromiseWithTimeout(this.deviceCommunicator.connect(), this.getDeviceStatusConnectTimeout);
        this.platform.log.debug('  * Device connected, reading...');
        const status = await this.waitForPromiseWithTimeout(
          this.deviceCommunicator.get({ schema: true }), this.getDeviceStatusReadTimeout) as DPSObject;
        this.platform.log.debug('  * Status:', status);
        this.updateDeviceState(status);
        this.state.isValid = true;
        this.updateAccessoryState();
      } catch (error) {
        this.platform.log.info('  *', error);
        this.deviceCommunicator.disconnect();
        this.state.isValid = false;
        isCommunicationError = true;
      } finally {
        this.isGetStatusInProgress = false;
        releaseMutex();
        this.platform.log.debug('  * Mutex unlocked after reading');
      }
    } else {
      this.platform.log.debug('  * Get device status has already been in progress');
    }

    const nextGetStatusPeriod = (isCommunicationError)
      ? this.getDeviceStatusFastRetryPeriod
      : this.getDeviceStatusPeriod;
    this.getDeviceStatusTimer = setTimeout(() => this.getDeviceStatus(), nextGetStatusPeriod);
    this.platform.log.debug(`[getDeviceStatus] --- Done. Next periodic getDeviceStatus in: ${nextGetStatusPeriod} ms`);
  }

  /**
   * Set device value.
   *
   * This method sends a command to the device to set the device into the
   * required state. Only one parameter can be set at a time.
   *
   * @param dps   The data point index of the device to be set.
   * @param value The value to be set.
   */
  private async setDeviceValue(dps: number, value: string | number | boolean) {
    this.platform.log.debug('[setDeviceStatus] --- Start');

    const releaseMutex = await this.mutex.lock();
    this.platform.log.debug('  * Mutex granted for sending, connecting to device...');

    try {
      await this.deviceCommunicator.connect();
      this.platform.log.debug('  * Device connected, sending...');
      const status = await this.deviceCommunicator.set({ dps: dps, set: value }) as DPSObject;
      this.platform.log.debug('  * Status:', status);
    } catch (error) {
      this.platform.log.debug('  *', error);
      this.deviceCommunicator.disconnect();
    } finally {
      releaseMutex();
      this.platform.log.debug('  * Mutex unlocked after sending');
    }

    this.platform.log.debug('[setDeviceStatus] --- Done');
  }

  /**
   * Set device value with timeout.
   *
   * This is a simple wrapper for the {@link setDeviceValue} method with a
   * timeout mechanism. If the method fails to execute within the
   * {@link setDeviceStatusTimeout} timeout, it throws a HomeKit No Response
   * status.
   *
   * @param dps   The data point index of the device to be set.
   * @param value The value to be set.
   */
  private async setDeviceValueWithTimeout(dps: number, value: string | number | boolean) {
    try {
      await this.waitForPromiseWithTimeout(
        this.setDeviceValue(dps, value),
        this.setDeviceStatusTimeout);
    } catch (error) {
      this.platform.log.debug('  *', error);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Wait for a promise to be resolved within a given timeout.
   *
   * @param promise The promise to be resolved within a given timeout.
   * @param ms      The timeout in [ms] within the promise should be resolved.
   * @return        The resolved promise if it gets resolved within the timeout, otherwise reject the promise.
   */
  private async waitForPromiseWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    const timeout = new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Waiting for promise timed out after ${ms} ms`)), ms),
    );
    return Promise.race([promise, timeout]);
  }

  /**
   * Throw a HomeKit No Response status if the accessory state is invalid.
   */
  private throwErrorIfDeviceUnresponsive() {
    if (!this.state.isValid) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Update the accessory state with the values received from the device.
   *
   * @param status The raw data points object received from the device.
   */
  private updateDeviceState(status: DPSObject) {
    this.state.fanOn = status.dps['60'] as boolean;
    this.state.fanSpeed = status.dps['62'] as number;
    this.state.fanRotationClockwise = (status.dps['63'] === 'forward') ? false : true;
    this.state.lightOn = status.dps['20'] as boolean;
  }

  /**
   * Update all accessory service characteristics based on the accessory state.
   */
  private updateAccessoryState() {
    this.fanService.updateCharacteristic(this.platform.Characteristic.Active,
      this.fanActiveValueToCharacteristicValue(),
    );

    this.fanService.updateCharacteristic(this.platform.Characteristic.RotationSpeed,
      this.fanRotationSpeedValueToCharacteristicValue(),
    );

    this.fanService.updateCharacteristic(this.platform.Characteristic.RotationDirection,
      this.fanRotationDirectionValueToCharacteristicValue(),
    );

    if (this.lightService) {
      this.lightService.updateCharacteristic(this.platform.Characteristic.On,
        this.lightOnValueToCharacteristicValue(),
      );
    }
  }

  /**
   * Convert the fan active state of the accessory to Fanv2 Active characteristic value.
   *
   * @return The Fanv2 Active characteristic value.
   */
  private fanActiveValueToCharacteristicValue(): CharacteristicValue {
    return (this.state.fanOn)
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  /**
   * Convert the fan rotation speed of the accessory to Fanv2 Rotation Speed characteristic value.
   *
   * @return The Fanv2 Rotation Speed characteristic value.
   */
  private fanRotationSpeedValueToCharacteristicValue(): CharacteristicValue {
    return this.fanRotationSpeedNormalized[this.state.fanSpeed - 1];
  }

  /**
   * Convert the fan rotation direction of the accessory to Fanv2 Rotation Direction characteristic value.
   *
   * @return The Fanv2 Rotation Direction characteristic value.
   */
  private fanRotationDirectionValueToCharacteristicValue(): CharacteristicValue {
    return (this.state.fanRotationClockwise)
      ? this.platform.Characteristic.RotationDirection.CLOCKWISE
      : this.platform.Characteristic.RotationDirection.COUNTER_CLOCKWISE;
  }

  /**
   * Convert the light on state of the accessory to Lightbulb On characteristic value.
   *
   * @return The Lightbulb On characteristic value.
   */
  private lightOnValueToCharacteristicValue(): CharacteristicValue {
    return this.state.lightOn;
  }

  /**
   * Adjust the rotation speed input value.
   *
   * This method is used for converting the input state of the slider value to
   * the nearest value that corresponds to the device fan speed.
   *
   * See the {@link CreateCeilingFanAccessory} class description for more details.
   *
   * @param value The input value of the rotation speed.
   * @return The adjusted value of the rotation speed.
   */
  private adjustInputRotationSpeed(value: number): number {
    if (value === 0) {
      return 0;
    }

    if (value < 20) {
      return this.fanRotationSpeedNormalized[0];
    } else if (value < 40) {
      return this.fanRotationSpeedNormalized[1];
    } else if (value < 60) {
      return this.fanRotationSpeedNormalized[2];
    } else if (value < 80) {
      return this.fanRotationSpeedNormalized[3];
    } else if (value < 95) {
      return this.fanRotationSpeedNormalized[4];
    } else {
      return this.fanRotationSpeedNormalized[5];
    }
  }
}
