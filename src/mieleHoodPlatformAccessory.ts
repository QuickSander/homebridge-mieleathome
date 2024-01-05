import { Service, PlatformAccessory, CharacteristicValue, CharacteristicSetCallback, CharacteristicGetCallback } from 'homebridge';

import { DEVICES_INFO_URL } from './settings';
import { MieleAtHomePlatform } from './platform';

import request from 'request';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class MieleHoodPlatformAccessory {
  private lightService: Service;
  private fanService: Service;
  private url: string;

  /**
   * These are just used to create a working example
   * You should implement your own code to track the state of your accessory
   */
  private States = {
    LightOn: false,
    FanOn: false,
    FanSpeed: 0,
  };

  constructor(
    private readonly platform: MieleAtHomePlatform,
    private readonly accessory: PlatformAccessory,
  ) {

    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Miele')
      .setCharacteristic(this.platform.Characteristic.Model, accessory.context.device.modelNumber)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.uniqueId);

    this.url = DEVICES_INFO_URL + '/' + accessory.context.device.uniqueId;

    this.platform.log.debug('URL ->', this.url);

    // Get the Switch service if it exists, otherwise create a new Switch service
    // you can create multiple services for each accessory
    this.lightService = this.accessory.getService(this.platform.Service.Switch) || this.accessory.addService(this.platform.Service.Switch);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.lightService.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName + ' Light');

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Switch

    // register handlers for the On/Off Characteristic
    this.lightService.getCharacteristic(this.platform.Characteristic.On)
      .on('set', this.setLightOn.bind(this))                // SET - bind to the `setOn` method below
      .on('get', this.getLightOn.bind(this));               // GET - bind to the `getOn` method below

    // Fan Service
    
    this.fanService = this.accessory.getService(this.platform.Service.Fan) ||
      this.accessory.addService(this.platform.Service.Fan);

    this.fanService.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName + ' Fan');

    this.fanService.getCharacteristic(this.platform.Characteristic.On)
      .on('get', this.getFanOn.bind(this))
      .on('set', this.setFanOn.bind(this));

    this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .on('get', this.getFanSpeed.bind(this))
      .on('set', this.setFanSpeed.bind(this))
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 25,
      });
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  setLightOn(value: CharacteristicValue, callback: CharacteristicSetCallback) {

    let httpdata = JSON.stringify({'light':2});

    if (value) {
      httpdata = JSON.stringify({'light':1});
    }

    const config = {
      'method': 'PUT',
      'url': this.url + '/actions',
      'headers': { 
        'Authorization': this.platform.token?.getAccessToken(),
        'Content-Type': 'application/json',
      },
      body: httpdata,
    };

    request(config, (err, _res, _body) => {
      if (err) {
        callback(err);
      }
      // NO PARSING BQ NO BODY!!!
      // implement your own code to turn your device on/off
      this.States.LightOn = value as boolean;
      this.platform.log.debug('End - Set Light Characteristic On ->', value);
      // you must call the callback function
      callback(null);
    });
  }
  
  setFanOn(value: CharacteristicValue, callback: CharacteristicSetCallback) {

    let httpdata = JSON.stringify({'powerOff':true});

    if (value) {
      httpdata = JSON.stringify({'powerOn':true});
    }

    const config = {
      'method': 'PUT',
      'url': this.url + '/actions',
      'headers': { 
        'Authorization': this.platform.token?.getAccessToken(),
        'Content-Type': 'application/json',
      },
      body: httpdata,
    };

    request(config, (err, _res, _body) => {
      if (err) {
        callback(err);
      }
      // NO PARSING BQ NO BODY!!!
      this.States.FanOn = value as boolean;
      this.platform.log.debug('End - Set Fan Characteristic On ->', value);
      // you must call the callback function
      callback(null);
    });
  }

  setFanSpeed(value: CharacteristicValue, callback: CharacteristicSetCallback) {

    let fanSpeed :string;

    if (value === '0') {
      fanSpeed = value;
    } else {
      fanSpeed = (Number(value)/25).toFixed();
      // Corrected formula to get right increments 25% = 1, 50% = 2, 75% = 3, 100% = 4
    }

    this.platform.log.debug('End - Set ventilationStep to -> ', fanSpeed);
    
    const httpdata = JSON.stringify({'ventilationStep':fanSpeed});

    const config = {
      'method': 'PUT',
      'url': this.url + '/actions',
      'headers': { 
        'Authorization': this.platform.token?.getAccessToken(),
        'Content-Type': 'application/json',
      },
      body: httpdata,
    };

    request(config, (err, _res, _body) => {
      if (err) {
        callback(err);
      }
      // NO PARSING BQ NO BODY!!!
      // implement your own code to turn your device on/off
      this.States.FanSpeed = value as number;
      this.platform.log.debug('End - Set Fan Characteristic Speed -> ', value);
      // you must call the callback function
      callback(null);
    });
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   * 
   * GET requests should return as fast as possbile. A long delay here will result in
   * HomeKit being unresponsive and a bad user experience in general.
   * 
   * If your device takes time to respond you should update the status of your device
   * asynchronously instead using the `updateCharacteristic` method instead.

   * @example
   * this.service.updateCharacteristic(this.platform.Characteristic.On, true)
   */
  
  getStatus(callback: CharacteristicGetCallback ) {

    const config = {
      'method': 'GET',
      'url': this.url + '/state',
      'headers': { 
        'Authorization': this.platform.token?.getAccessToken(),
        'Content-Type': 'application/json',
      },
    };

    request(config, (err, _res, body) => {
      if (err) {
        callback(err);
      }

      this.platform.log.debug('Status Body -> ', body);

      const response = JSON.parse(body);

      // Get Light status

      this.platform.log.debug('Light Value -> ', response.light);

      if (response.light === 1) {
        this.States.LightOn = true;
      } else {
        this.States.LightOn = false;
      }

      // Get Fan status

      this.platform.log.debug('Fan Step -> ', response.ventilationStep.value_raw);

      if (response.ventilationStep.value_raw === 0 || response.ventilationStep.value_raw === null ) {
        this.States.FanOn = false;
      } else {
        this.States.FanOn = true;
      }
      this.States.FanSpeed = response.ventilationStep.value_raw * 25;
      
    });
  }

  getLightOn(callback: CharacteristicGetCallback) {

    this.getStatus(callback);

    const isOn = this.States.LightOn;
    this.platform.log.debug('Get Characteristic On ->', isOn);
    
    // you must call the callback function
    // the first argument should be null if there were no errors
    // the second argument should be the value to return
    callback(null, isOn);
  }

  getFanOn(callback: CharacteristicGetCallback){

    this.getStatus(callback);

    const fanOn = this.States.FanOn;
    this.platform.log.debug('Fan On -> ', fanOn);
    // you must call the callback function
    // the first argument should be null if there were no errors
    // the second argument should be the value to return
    callback(null, fanOn);
  }

  getFanSpeed(callback: CharacteristicGetCallback){

    this.getStatus(callback);

    const fanSpeed = this.States.FanSpeed;
    this.platform.log.debug('Fan Speed -> ', fanSpeed);
    // you must call the callback function
    // the first argument should be null if there were no errors
    // the second argument should be the value to return
    callback(null, fanSpeed);
  }
}
