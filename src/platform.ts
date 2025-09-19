import type {
  API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service,
} from 'homebridge';
import { CreateCeilingFanAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

/**
 * CreateCeilingFanPlatform: the platform implementation for CREATE ceiling fans.
 *
 * This class contains the platform implementation and follows the Homebridge
 * plugin development recommendations.
 *
 * @see https://developers.homebridge.io/#/
 * @see https://github.com/homebridge/homebridge-plugin-template/blob/latest/README.md
 */
export class CreateCeilingFanPlatform implements DynamicPlatformPlugin {
  /** The HomeKit Accessory Protocol (HAP) service. */
  public readonly Service: typeof Service;
  /** The HomeKit Accessory Protocol (HAP) characteristic. */
  public readonly Characteristic: typeof Characteristic;

  /** Used for tracking the restored cached accessories. */
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  /** Used for tracking the cached UUIDs. */
  public readonly discoveredCacheUUIDs: string[] = [];

  /**
   * The CreateCeilingFanPlatform constructor.
   *
   * Note: This constructor is called by Homebridge.
   *
   * @param log    The logging object.
   * @param config The platform configuration object.
   * @param api    The API object.
   */
  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    // When this event is fired, it means Homebridge has restored all cached
    // accessories from the disk. Dynamic Platform plugins should only register
    // new accessories after this event was fired, in order to ensure they
    // weren't added to Homebridge already. This event can also be used to
    // start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when Homebridge restores cached accessories from
   * the disk at startup. It should be used to set up event handlers for
   * characteristics and update respective values.
   *
   * @param accessory The accessory restored from the disk at startup.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // Add the restored accessory to the accessories cache to track if it has
    // already been registered
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * Register discovered accessories.
   *
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  private discoverDevices() {
    // Loop over the devices and register each one if it has not already been registered
    for (const device of this.config.devices) {
      // Generate a unique id for the accessory
      // Note: this should be generated from something globally unique, but
      // constant, for example, the device serial number or MAC address
      const uuid = this.api.hap.uuid.generate(device.id);

      // See if an accessory with the same uuid has already been registered and restored
      // from the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache: %s (device id: %s)',
          existingAccessory.displayName,
          existingAccessory.context.device.id,
        );

        // Update the `accessory.context` in case the plugin configuration (in the config.json) has changed
        existingAccessory.context.device = device;
        this.api.updatePlatformAccessories([existingAccessory]);

        // Create the accessory handler for the restored accessory
        new CreateCeilingFanAccessory(this, existingAccessory);
      } else {
        this.log.info('Adding new accessory: %s (device id: %s)', device.name, device.id);

        // Create a new accessory
        const accessory = new this.api.platformAccessory(device.name, uuid);

        // Store a copy of the device object in the `accessory.context`
        accessory.context.device = device;

        // Create the accessory handler for the newly created accessory
        new CreateCeilingFanAccessory(this, accessory);

        // Link the accessory to the platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      // Push into discoveredCacheUUIDs
      this.discoveredCacheUUIDs.push(uuid);
    }

    // Remove existing cached accessories from Homebridge if they are no longer present
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing existing accessory from cache: %s (device id: %s)',
          accessory.displayName, accessory.context.device.id);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}
