// Apache License
// Copyright (c) 2023, Wilko Eisele

import { Service, PlatformAccessory } from 'homebridge';

import { MieleAtHomePlatform } from './platform';
import { MieleBasePlatformAccessory, MieleState } from './mieleBasePlatformAccessory';

import { MieleOnCharacteristic, MieleVapourOnCharacteristic, MieleRotationSpeedCharacteristic } from './mieleCharacteristics';

//-------------------------------------------------------------------------------------------------
// Class Hob with vapour extraction
//-------------------------------------------------------------------------------------------------
export class MieleHobVapourPlatformAccessory extends MieleBasePlatformAccessory {
  private vapourService: Service | undefined;

  //-----------------------------------------------------------------------------------------------
  constructor(
    platform: MieleAtHomePlatform,
    accessory: PlatformAccessory,
  ) {
    super(platform, accessory);
  
    this.mainService = this.accessory.getService(this.platform.Service.Outlet) ||
      this.accessory.addService(this.platform.Service.Outlet);

    // Set the service name, this is what is displayed as the default name on the Home app
    this.mainService.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);

    const onCharacteristic = new MieleOnCharacteristic(this.platform, this.mainService, accessory.context.device.uniqueId);

    this.characteristics.push(onCharacteristic);

    // Each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Switch
    this.mainService.getCharacteristic(this.platform.Characteristic.On)
      .on('get', onCharacteristic.get.bind(onCharacteristic))
      .on('set', onCharacteristic.set.bind(onCharacteristic));


    this.vapourService = this.accessory.getService(this.platform.Service.Fan) || this.accessory.addService(this.platform.Service.Fan);

    // Set the service name, this is what is displayed as the default name on the Home app
    this.vapourService.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);

    const vapourOnCharacteristic = new MieleVapourOnCharacteristic(this.platform, this.vapourService);
    const rotationSpeedCharacteristic = new MieleRotationSpeedCharacteristic(this.platform, this.vapourService);

    this.characteristics.push(vapourOnCharacteristic);
    this.characteristics.push(rotationSpeedCharacteristic);

    // Each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Switch
    this.vapourService.getCharacteristic(this.platform.Characteristic.On)
      .on('get', vapourOnCharacteristic.get.bind(vapourOnCharacteristic));
    this.vapourService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .on('get', rotationSpeedCharacteristic.get.bind(rotationSpeedCharacteristic))
  }
  
}


