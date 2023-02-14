// Apacche License
// Copyright (c) 2020, Sander van Woensel

import { Service, CharacteristicValue, CharacteristicSetCallback, CharacteristicGetCallback } from 'homebridge';

import { REVERT_ACTIVATE_REQUEST_TIMEOUT_MS } from './settings';
import { MieleAtHomePlatform, createErrorString } from './platform';
import { MieleStatusResponse, MieleState, MieleStatusResponseTemp } from './mieleBasePlatformAccessory';
import axios from 'axios';

enum MieleProcessAction {
  Start = 1,
  Stop = 2,
  Pause = 3,
  StartSuperFreezing = 4,
  StopSuperFreezing = 5,
  StartSuperCooling = 6,
  StopSuperCooling = 7,
}

//-------------------------------------------------------------------------------------------------
// Interface Miele Characteristic
//-------------------------------------------------------------------------------------------------
export interface IMieleCharacteristic {
  get(callback: CharacteristicGetCallback): void; 
  set(value: CharacteristicValue, callback: CharacteristicSetCallback): void;
  update(response: MieleStatusResponse): void;
}

//-------------------------------------------------------------------------------------------------
// Miele Base Characteristic
//-------------------------------------------------------------------------------------------------
abstract class MieleBaseCharacteristic implements IMieleCharacteristic {

  protected readonly deviceName;

  constructor(
    protected platform: MieleAtHomePlatform,
    protected service: Service,
    protected readonly characteristic,
    protected value,
  ) {
    this.deviceName = this.service.getCharacteristic(this.platform.Characteristic.Name).value;
  }

  //-------------------------------------------------------------------------------------------------
  // These methods always returns the status from cache as the cache is updated from the event server.
  get(callback: CharacteristicGetCallback) {
    this.platform.log.debug(`${this.deviceName}: Returning ${this.value} for ${this.characteristic.name}.`);
    callback(null, this.value);
  }

  //-------------------------------------------------------------------------------------------------
  set(_value: CharacteristicValue, _callback: CharacteristicSetCallback): void {
    throw new Error('"set method mut be overridden.');
  }

  //-------------------------------------------------------------------------------------------------
  update(_response: MieleStatusResponse): void {
    throw new Error('"update" method must be overridden.');
  }

  //-------------------------------------------------------------------------------------------------
  // Update value only when not equal to cached value.
  protected updateCharacteristic(value: CharacteristicValue, logInfo = true) {
    if(value!==this.value) {
      const logStr = `${this.deviceName}: Updating characteristic ${this.characteristic.name} to ${value}.`;
      if(logInfo) {
        this.platform.log.info(logStr);
      } else {
        this.platform.log.debug(logStr);
      }
      this.value = value;
      this.service.updateCharacteristic(this.characteristic, this.value);
    }
  }

  //-------------------------------------------------------------------------------------------------
  // Undo state
  protected undoSetState(value: CharacteristicValue) {
    if(value !== this.value) {
      this.platform.log.info(`${this.deviceName}: Reverting state to ${this.value}.`);

      setTimeout(()=> {
        this.service.updateCharacteristic(this.characteristic, this.value); 
      }, REVERT_ACTIVATE_REQUEST_TIMEOUT_MS);
    }
  }

}

//-------------------------------------------------------------------------------------------------
// Base class: Miele Binary State Characteristic
//-------------------------------------------------------------------------------------------------
abstract class MieleBinaryStateCharacteristic extends MieleBaseCharacteristic {
      
  constructor(
    platform: MieleAtHomePlatform,
    service: Service,
    private readonly inactiveStates: MieleState[] | null,
    private readonly activeStates: MieleState[] | null,
    characteristicType,
    protected readonly offState: number,
    protected readonly onState: number,
  ) {
    super(platform, service, characteristicType, offState);
  }

  set(_value: CharacteristicValue, _callback: CharacteristicSetCallback): void {
    throw new Error('"set" method must be overridden.');
  }

  //-------------------------------------------------------------------------------------------------
  update(response: MieleStatusResponse): void {
    this.platform.log.debug(`${this.deviceName}: Update received for ${this.characteristic.name} raw value: ${response.status.value_raw}.`);

    let value = this.offState;

    if (this.inactiveStates) {
      if(!this.inactiveStates.includes(response.status.value_raw)) {
        value = this.onState;
      }
    } else if (this.activeStates) {
      if(this.activeStates.includes(response.status.value_raw)) {
        value = this.onState;
      }
    } else {
      throw new Error(`${this.deviceName}: Neither active or inactive states supplied. Cannot determine state.`);
    }
    
    this.updateCharacteristic(value);
  }

}


//-------------------------------------------------------------------------------------------------
// Miele InUse Characteristic. 
//-------------------------------------------------------------------------------------------------
export class MieleInUseCharacteristic extends MieleBinaryStateCharacteristic {
      
  constructor(
    platform: MieleAtHomePlatform,
    service: Service,
    inactiveStates: MieleState[] | null,
    activeStates: MieleState[] | null,
  ) {
    super(platform, service, inactiveStates, activeStates, platform.Characteristic.InUse,
      platform.Characteristic.InUse.NOT_IN_USE,
      platform.Characteristic.InUse.IN_USE);
  }
}


//-------------------------------------------------------------------------------------------------
// Miele OutletInUse Characteristic. 
//-------------------------------------------------------------------------------------------------
export class MieleOutletInUseCharacteristic extends MieleBinaryStateCharacteristic {
      
  constructor(
    platform: MieleAtHomePlatform,
    service: Service,
    inactiveStates: MieleState[] | null,
    activeStates: MieleState[] | null,
  ) {
    super(platform, service, inactiveStates, activeStates, platform.Characteristic.OutletInUse, 0, 1);
  }
}


//-------------------------------------------------------------------------------------------------
// Miele Current Cooling Characteristic. 
//-------------------------------------------------------------------------------------------------
export class MieleCurrentCoolingCharacteristic extends MieleBinaryStateCharacteristic {
      
  constructor(
    platform: MieleAtHomePlatform,
    service: Service,
    inactiveStates: MieleState[] | null,
    activeStates: MieleState[] | null,
  ) {
    super(platform, service, inactiveStates, activeStates, platform.Characteristic.CurrentHeatingCoolingState,
      platform.Characteristic.CurrentHeatingCoolingState.OFF,
      platform.Characteristic.CurrentHeatingCoolingState.COOL);
  }
}




//-------------------------------------------------------------------------------------------------
// Miele Writable Binary State Characteristic. 
//-------------------------------------------------------------------------------------------------
export class MieleWritableBinaryStateCharacteristic extends MieleBinaryStateCharacteristic {      
  
  constructor(
    platform: MieleAtHomePlatform,
    service: Service,
    inactiveStates: MieleState[] | null,
    activeStates: MieleState[] | null,
    characteristicType,
    private mieleOffState: MieleProcessAction,
    characteristicOff: number,
    private mieleOnState: MieleProcessAction,
    characteristicOn: number,
    private serialNumber: string,
    private disableDeactivateAction: boolean,
  ) {
    super(platform, service, inactiveStates, activeStates, characteristicType,
      characteristicOff,
      characteristicOn);
  }

  //-------------------------------------------------------------------------------------------------
  // Set
  async set(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    this.platform.log.debug(`${this.deviceName}: Set characteristic ${this.characteristic.name} to: ${value}`);
    
    callback(null);

    if(this.disableDeactivateAction && value===this.offState) {
      this.platform.log.info(`${this.deviceName} (${this.serialNumber}): Ignoring deactivate request. `+
        'User disabled deactivation request for this device.');
      this.undoSetState(value);
      return;
    }

    try {
      // Retrieve allowed actions for this device in the current state.
      const response = await axios.get(this.platform.getActionsUrl(this.serialNumber), this.platform.getHttpRequestConfig());
      this.platform.log.debug(`${this.deviceName} (${this.serialNumber}): Allowed process actions: ${response.data.processAction}.`);

      let mieleProcesAction = this.mieleOffState;
      if(value===this.onState) {
        mieleProcesAction = this.mieleOnState;
      }

      // If allowed to execute action.
      if(response.data.processAction.includes(mieleProcesAction)) {
        this.platform.log.info(`${this.deviceName} (${this.serialNumber}): Process action `+
          `"${MieleProcessAction[mieleProcesAction]}" (${mieleProcesAction}).`);
        const response = await axios.put(this.platform.getActionsUrl(this.serialNumber), {processAction: mieleProcesAction},
          this.platform.getHttpRequestConfig());
        this.platform.log.debug(`${this.deviceName}: Process action response code: ${response.status}: "${response.statusText}"`);
      } else {
        // Requested action not allowed
        this.platform.log.info(`${this.deviceName} (${this.serialNumber}): Ignoring request to set device to HomeKit value ${value}. `+
          `Miele action "${MieleProcessAction[mieleProcesAction]}" (${mieleProcesAction}) not allowed in current device state. `+
          `Allowed Miele process actions: ${response.data.processAction ? '<none>' : response.data.processAction}`);
        
        // Undo state change to emulate a readonly state (since HomeKit valves are read/write)
        this.undoSetState(value);
      }      
    } catch (response) {
      this.platform.log.error( createErrorString(response) );
      this.service.setCharacteristic(this.platform.Characteristic.StatusFault, this.platform.Characteristic.StatusFault.GENERAL_FAULT);

    }
  }

}

//-------------------------------------------------------------------------------------------------
// Miele Active Characteristic. 
//-------------------------------------------------------------------------------------------------
export class MieleActiveCharacteristic extends MieleWritableBinaryStateCharacteristic {      
  
  constructor(
    platform: MieleAtHomePlatform,
    service: Service,
    inactiveStates: MieleState[] | null,
    activeStates: MieleState[] | null,
    serialNumber: string,
    disableStopAction: boolean,
  ) {
    super(platform, service, inactiveStates, activeStates, platform.Characteristic.Active,
      MieleProcessAction.Stop, platform.Characteristic.Active.INACTIVE,
      MieleProcessAction.Start, platform.Characteristic.Active.ACTIVE, 
      serialNumber, disableStopAction);

  }
}

//-------------------------------------------------------------------------------------------------
// Miele Target Cooling state Characteristic. 
//-------------------------------------------------------------------------------------------------
export class MieleTargetCoolingCharacteristic extends MieleWritableBinaryStateCharacteristic {      
  
  constructor(
    platform: MieleAtHomePlatform,
    service: Service,
    inactiveStates: MieleState[] | null,
    activeStates: MieleState[] | null,
    serialNumber: string,
    disableDeactivateAction: boolean,
  ) {
    super(platform, service, inactiveStates, activeStates, platform.Characteristic.TargetHeatingCoolingState,
      MieleProcessAction.StopSuperCooling, platform.Characteristic.CurrentHeatingCoolingState.OFF,
      MieleProcessAction.StartSuperCooling, platform.Characteristic.CurrentHeatingCoolingState.COOL, 
      serialNumber, disableDeactivateAction);
  }
}

//-------------------------------------------------------------------------------------------------
// Miele Remaining Duration Characteristic
//-------------------------------------------------------------------------------------------------
export class MieleRemainingDurationCharacteristic extends MieleBaseCharacteristic {
      
  //private readonly MAX_HOMEKIT_DURATION_S = 3600;

  constructor(
    protected platform: MieleAtHomePlatform,
    protected service: Service,
  ) {
    super(platform, service, platform.Characteristic.RemainingDuration, 0);
  }

  //-------------------------------------------------------------------------------------------------
  update(response: MieleStatusResponse): void {
    let value = response.remainingTime[0]*3600 + response.remainingTime[1]*60;
    this.platform.log.debug(`${this.deviceName}: Remaining Duration update received: ${value}[s]`);

    // Clip to min and max value.
    const characteristic = this.service.getCharacteristic(this.platform.Characteristic.RemainingDuration);
    const maxValue = characteristic.props.maxValue;
    const minValue = characteristic.props.minValue;

    if(maxValue && minValue) {
      value = value > maxValue ? maxValue : value;
      value = value < minValue ? minValue : value;
    }

    // Do not allow any invalid value to pass through.
    if(typeof(value)!=='number' || Number.isNaN(value)) {
      this.platform.log.debug(`${this.deviceName}: Prevented setting NaN or another non-number type for Remaining Duration.`);
      value = 0;
    }

    this.updateCharacteristic(value, false);
  }

}

//-------------------------------------------------------------------------------------------------
// Miele Temperature Characteristic
//-------------------------------------------------------------------------------------------------
export enum TemperatureType {
  Target,
  Current
}

export class MieleTempCharacteristic extends MieleBaseCharacteristic {  
  private readonly NULL_VALUE = 2**16/-2;
  private readonly TEMP_CONVERSION_FACTOR = 100.0;
  protected readonly DEFAULT_ZONE = 1; // Currently only 1 temperature zone supported.

  constructor(
    platform: MieleAtHomePlatform,
    service: Service,
    protected type: TemperatureType,
    characteristic,
    private offTemp: number,
  ) {
    super(platform, service, characteristic, offTemp);
  }

  //-------------------------------------------------------------------------------------------------
  update(response: MieleStatusResponse): void {
    let tempArray: MieleStatusResponseTemp[];
    let value = this.offTemp; // Set target temperature to 'off' when no target temperature available since device is off.

    switch(this.type) {
      case TemperatureType.Target:
        tempArray = response.targetTemperature;
        break;
      case TemperatureType.Current:
        tempArray = response.temperature;
        break;
    }
    
    if(tempArray.length > 0) {
      const valueRaw = tempArray[this.DEFAULT_ZONE-1].value_raw; // Fetch first temperature only.
      this.platform.log.debug(`${this.deviceName}: Zone ${this.DEFAULT_ZONE} ${TemperatureType[this.type]} `+
        `Temperature update received: ${valueRaw}[C/${this.TEMP_CONVERSION_FACTOR}]`);
    
      if(valueRaw !== this.NULL_VALUE) {
        value = valueRaw / this.TEMP_CONVERSION_FACTOR; // Miele returns values in centi-Celsius
      }

      // Clip to min and max value.
      const characteristicObj = this.service.getCharacteristic(this.characteristic);
      const maxValue = characteristicObj.props.maxValue;
      const minValue = characteristicObj.props.minValue;

      if(maxValue && minValue) {
        value = value > maxValue ? maxValue : value;
        value = value < minValue ? minValue : value;
      }

      this.updateCharacteristic(value);
       
    }
  }

}

//-------------------------------------------------------------------------------------------------
// Miele Target Temperature Characteristic
//-------------------------------------------------------------------------------------------------
export class MieleTargetTempCharacteristic extends MieleTempCharacteristic {  

  constructor(
    platform: MieleAtHomePlatform,
    service: Service,
    private serialNumber: string,
    offTemp: number,
    private disableSetTargetTemp: boolean,
  ) {
    super(platform, service, TemperatureType.Target, platform.Characteristic.TargetTemperature, offTemp);
  }

  //-------------------------------------------------------------------------------------------------
  // Set
  async set(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    callback(null);

    if(this.disableSetTargetTemp) {
      this.platform.log.info(`${this.deviceName} (${this.serialNumber}): Ignoring set ${TemperatureType[this.type]} temperature request. `+
        `User disabled modifying ${TemperatureType[this.type]} temperature for this device.`);
      this.undoSetState(value);
      return;
    }

    this.platform.log.debug(`${this.deviceName}: Set characteristic "${TemperatureType[this.type]} temperature" to: ${value}`);

    try {
      const response = await axios.put(this.platform.getActionsUrl(this.serialNumber),
        {targetTemperature:
          [{zone:this.DEFAULT_ZONE, value: value}], // Setting is done in Celsius, retrieving returns centi-Celsius.
        }, this.platform.getHttpRequestConfig());

      this.platform.log.debug(`${this.deviceName}: Set target temperature response code: ${response.status}: "${response.statusText}"`);


    } catch(response) {
      if(response.response && response.response.status === 500) {
        this.platform.log.warn(`${this.deviceName}: Set target temperature: ignoring Miele API fault reply code `+
          ` ${response.response.status}. `+
          'Device most probably still acknowlegded (known Miele API misbehaviour).');
      } else {
        this.undoSetState(value);

        this.platform.log.error( createErrorString(response) );
        // TODO: This characteristic needs to be added first.
        this.service.setCharacteristic(this.platform.Characteristic.StatusFault, this.platform.Characteristic.StatusFault.GENERAL_FAULT);
      }
    }
  }

}


//-------------------------------------------------------------------------------------------------
// Miele Temperature Unit Characteristic
//-------------------------------------------------------------------------------------------------
export class MieleTemperatureUnitCharacteristic extends MieleBaseCharacteristic {

  constructor(
    platform: MieleAtHomePlatform,
    service: Service,
  ) {
    super(platform, service, platform.Characteristic.TemperatureDisplayUnits, platform.Characteristic.TemperatureDisplayUnits.CELSIUS);
  }

  //-------------------------------------------------------------------------------------------------
  update(response: MieleStatusResponse): void {
    let value = this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
    
    if(response.temperature[0].unit === 'Fahrenheit' ) {
      value = this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
    }

    this.updateCharacteristic(value);
  }

}


//-------------------------------------------------------------------------------------------------
// Base class: Miele On Characteristic
//-------------------------------------------------------------------------------------------------
export class MieleOnCharacteristic extends MieleBaseCharacteristic {      
  
  constructor(
    platform: MieleAtHomePlatform,
    service: Service,
    private serialNumber: string,
  ) {
    super(platform, service, platform.Characteristic.On, false);
  }

  async set(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    this.platform.log.debug(`${this.deviceName}: Set characteristic ${this.characteristic.name} to: ${value}`);

    callback(null);

    try {
      const response = await axios.get(this.platform.getActionsUrl(this.serialNumber),
        this.platform.getHttpRequestConfig());

      const action = value ? 'powerOn' : 'powerOff';
      if (response.data[action]) {
        const data = {};
        data[action] = true;
        const response = await axios.put(this.platform.getActionsUrl(this.serialNumber), data,
          this.platform.getHttpRequestConfig());
        this.platform.log.debug(`${this.deviceName}: Process action response code: ${response.status}: "${response.statusText}"`);
        this.value = value;

      } else {
        this.platform.log.info(`${this.deviceName} (${this.serialNumber}): ` +
          `Ignoring request to power ${value ? 'on' : 'off'} the device: not allowed in current device state. ` +
          `Allowed power actions: on=${response.data.powerOn}, off=${response.data.powerOff}`);
        this.undoSetState(value);
      }

    } catch (error) {
      this.platform.log.error(createErrorString(error));
      this.undoSetState(value);
    }
  }

  update(response: MieleStatusResponse): void {
    this.platform.log.debug(`${this.deviceName}: Update received for ${this.characteristic.name} raw value: ${response.status.value_raw}.`);

    const value = response.status.value_raw !== MieleState.Off;
    this.updateCharacteristic(value);
  }
}

//-------------------------------------------------------------------------------------------------
// Base class: Miele VapourOn Characteristic
//-------------------------------------------------------------------------------------------------
export class MieleVapourOnCharacteristic extends MieleBaseCharacteristic {      
  
  constructor(
    platform: MieleAtHomePlatform,
    service: Service
  ) {
    super(platform, service, platform.Characteristic.On, false);
  }

  update(response: MieleStatusResponse): void {
    this.platform.log.debug(`${this.deviceName}: Update received for ${this.characteristic.name} raw value: ${response.ventilationStep.value_raw}.`);

    const value = response.ventilationStep.value_raw > 0 ? true : false;
    this.updateCharacteristic(value);
  }
}

//-------------------------------------------------------------------------------------------------
// Base class: Miele RotationSpeed Characteristic
//-------------------------------------------------------------------------------------------------
export class MieleRotationSpeedCharacteristic extends MieleBaseCharacteristic {      
  
  constructor(
    platform: MieleAtHomePlatform,
    service: Service
  ) {
    super(platform, service, platform.Characteristic.RotationSpeed, 0);
  }

  update(response: MieleStatusResponse): void {
    this.platform.log.debug(`${this.deviceName}: Update received for ${this.characteristic.name} raw value: ${response.ventilationStep.value_raw}.`);

    let value = response.ventilationStep.value_raw * 25;

    // Clip to min and max value.
    const characteristicObj = this.service.getCharacteristic(this.characteristic);
    const maxValue = characteristicObj.props.maxValue;
    const minValue = characteristicObj.props.minValue;

    if(maxValue && minValue) {
      value = value > maxValue ? maxValue : value;
      value = value < minValue ? minValue : value;
    }

    this.updateCharacteristic(value);
  }
}
