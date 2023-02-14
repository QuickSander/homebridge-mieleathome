// Apacche License
// Copyright (c) 2020, Sander van Woensel

import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, DEVICES_INFO_URL, DEFAULT_RECONNECT_EVENT_SERVER_INTERVAL_MIN} from './settings';
import { MieleHoodPlatformAccessory } from './mieleHoodPlatformAccessory';
import { MieleWasherDryerPlatformAccessory } from './mieleWasherDryerPlatformAccessory';
import { MieleFridgePlatformAccessory } from './mieleFridgePlatformAccessory';
import { MieleCoffeeSystemPlatformAccessory } from './mieleCoffeeSystemPlatformAccessory';
import { MieleHobVapourPlatformAccessory } from './mieleHobVapourPlatformAccessory';
import { Token } from './token';

import axios from 'axios';

export function createErrorString(err) : string {
  let errStr = '';
  if(err.config) {
    errStr += `Miele API request ${err.config.url} failed.`;
  }
  if(err.response) {
    errStr += ` Status ${err.response.status}: "${err.response.statusText}".`;
  }
  
  if(err.code && err.syscall) {
    errStr += `Error: ${err.syscall} ${err.code}`;
  } else {
    errStr += err;
  }
  return errStr;
}

enum MieleDeviceIds {
  Washer = 1,
  Dryer = 2,
  Dishwasher = 7,
  CoffeeSystem = 17,
  Hood = 18,
  Fridge = 19,
  Freezer = 20,
  FridgeFreezer = 21,
  WasherDryer = 24,
  HobVapour = 74,
}

//-------------------------------------------------------------------------------------------------
// Class MieleAtHomePlatform
//-------------------------------------------------------------------------------------------------
export class MieleAtHomePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // This is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  public token: Token | null = null;
  public readonly reconnectEventServerInterval: number = parseInt(<string>this.config.reconnectEventServerInterval ||
    `${DEFAULT_RECONNECT_EVENT_SERVER_INTERVAL_MIN}`);

  public readonly language = this.config.language || '';
  public readonly disableStopActionFor: string[] = <string[]>this.config.disableStopActionFor || [];
  public readonly disableTempSensorFor: string[] = <string[]>this.config.disableTempSensorFor || [];
  public readonly disableSetTargetTempFor: string[] = <string[]>this.config.disableSetTargetTempFor || [];

  //-----------------------------------------------------------------------------------------------
  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    // Verify configuration
    this.verifyConfig('clientID');
    this.verifyConfig('clientSecret');


    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');

      Token.construct(this).then((token) => {
        this.token = token;
        this.discoverDevices();
      });
    });
  }

  //-----------------------------------------------------------------------------------------------
  // This function is invoked when homebridge restores cached accessories from disk at startup.
  // It should be used to setup event handlers for characteristics and update respective values.
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory data from cache:', accessory.displayName);

    // Add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  //-----------------------------------------------------------------------------------------------
  // Discover devices from Miele web API and construct supproted devices.
  private async discoverDevices() {

    try {
      const url = DEVICES_INFO_URL+'?language='+this.language;
      this.log.debug(`Requesting devices: "${url}"`);
      const response = await axios.get(url, this.getHttpRequestConfig());
      
      const allDeviceIds = Object.keys(response.data);
      this.log.debug('Discovered devices: ', allDeviceIds);

      // Loop over the discovered devices and register each one if it has not already been registered
      for (const deviceId of allDeviceIds) {

        const device = response.data[deviceId];
        const deviceObject = {
          uniqueId: deviceId,
          firmwareRevision: device.ident.xkmIdentLabel.releaseVersion || 'Unknonw Miele firmware',
          displayName: device.ident.deviceName || device.ident.type.value_localized || MieleDeviceIds[device.ident.type.value_raw] ||
            `Unnamed ${deviceId}`,
          modelNumber: device.ident.deviceIdentLabel.techType || 'Unknown Miele model',
        };

        this.log.info(`Discovered device: id: ${deviceObject.uniqueId}, `+
                      `name: ${deviceObject.displayName}, model: ${deviceObject.modelNumber}`);

        // Generate a unique id for the accessory.
        const uuid = this.api.hap.uuid.generate(deviceObject.uniqueId);

        // See if an accessory with the same uuid has already been registered and restored from
        // the cached devices we stored in the `configureAccessory` method above
        const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

        if (existingAccessory) {
          // The accessory already exists
          this.log.info('Re-creating existing accessory with data from cache:', existingAccessory.displayName);
          existingAccessory.context.device = deviceObject; // Update cache with newest data.

          const accessoryObj = this.constructPlatformAccessory(device.ident.type.value_raw, existingAccessory);

          if(!accessoryObj) {
            this.log.error('Retrieved accessory from cache, but its raw type value is not a supported device. '+
                           `Device: "${deviceObject.displayName}" `+
                           `with raw type value: ${device.ident.type.value_raw}.`);
          }

        } else {
          // The accessory does not yet exist, so we need to create it.
          // Create a new accessory which might be disposed of later when the device is not supported.
          const accessory = new this.api.platformAccessory(deviceObject.displayName, uuid);

          // Store a copy of the device object in the `accessory.context`
          // the `context` property can be used to store any data about the accessory you may need
          accessory.context.device = deviceObject;

          const accessoryObj = this.constructPlatformAccessory(device.ident.type.value_raw, accessory);

          if(accessoryObj) {
            // Link the newly created accessory to your platform.
            this.log.info('Registering new accessory:', deviceObject.displayName);
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          } else {
            this.log.info('Ignoring unsupported device. '+
                          `Device: "${deviceObject.displayName}" `+
                          `with raw type value: ${device.ident.type.value_raw}.`);
          }
        }
      }

    } catch(response) {
      if(response.config && response.response) {
        this.log.error(`Miele API request ${response.config.url} failed with status ${response.response.status}: `+
                                `"${response.response.statusText}".`);
      } else {
        this.log.error(response);
      }
    }
  }

  //-----------------------------------------------------------------------------------------------
  // Construct accessory
  private constructPlatformAccessory(raw_id: number, accessory: PlatformAccessory) {

    // TODO: Get Platform action properties as required input to construct devices.
    // Receive initialState.



    switch (raw_id) {
      case MieleDeviceIds.Hood:
        // TODO: Change to class deriving from BasePlatformAccessory.
        return new MieleHoodPlatformAccessory(this, accessory);

      case MieleDeviceIds.WasherDryer:
      case MieleDeviceIds.Washer:
      case MieleDeviceIds.Dishwasher: 
        //  return new MieleFridgePlatformAccessory(this, accessory,
        //    this.disableStopActionFor.includes(MieleDeviceIds[raw_id]),
        //    this.disableSetTargetTempFor.includes(MieleDeviceIds[raw_id]));
        return new MieleWasherDryerPlatformAccessory(this, accessory, 
          this.disableStopActionFor.includes(MieleDeviceIds[raw_id]),
          this.disableTempSensorFor.includes(MieleDeviceIds[raw_id]));

      case MieleDeviceIds.Dryer:
        return new MieleWasherDryerPlatformAccessory(this, accessory, 
          this.disableStopActionFor.includes(MieleDeviceIds[raw_id]),
          true); // Dryer is estimated to not have a target temp attribute.
      
      case MieleDeviceIds.Fridge:
      case MieleDeviceIds.Freezer:
      case MieleDeviceIds.FridgeFreezer:
        return new MieleFridgePlatformAccessory(this, accessory,
          this.disableStopActionFor.includes(MieleDeviceIds[raw_id]),
          this.disableSetTargetTempFor.includes(MieleDeviceIds[raw_id]));

      case MieleDeviceIds.CoffeeSystem:
        return new MieleCoffeeSystemPlatformAccessory(this, accessory);

      case MieleDeviceIds.HobVapour:
        return new MieleHobVapourPlatformAccessory(this, accessory);
    
      default:
        return null;
      
    }
  }

  //-----------------------------------------------------------------------------------------------
  // Verify crucial configuration parameters.
  private verifyConfig(configParameterStr: string) {
    if(!this.config[configParameterStr]) {
      this.log.error(`Configuration parameter "${configParameterStr}" invalid. Will attempt to continue, `+
        'but please complete the plug-in configuration.');
    }
    
  }

  //-----------------------------------------------------------------------------------------------
  // Retrieve generic usable HTTP parameters.
  public getHttpRequestConfig(): {headers: Record<string, unknown>} {
    return {
      'headers': { 
        'Authorization': this.token?.getAccessToken(),
        'Content-Type': 'application/json',
      },
    };
  }

  //-----------------------------------------------------------------------------------------------
  // Retrieve actions URL
  public getActionsUrl(serialNumber: string): string {
    return DEVICES_INFO_URL + '/' + serialNumber + '/actions';
  }

}
