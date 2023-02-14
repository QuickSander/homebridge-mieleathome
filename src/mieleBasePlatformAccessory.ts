// Apacche License
// Copyright (c) 2020, Sander van Woensel

import { PlatformAccessory, CharacteristicSetCallback, Service, CharacteristicValue } from 'homebridge';

import { DEVICES_INFO_URL, EVENT_SERVER_RECONNECT_DELAY_S, DEFAULT_RECONNECT_EVENT_SERVER_INTERVAL_MIN } from './settings';
import { MieleAtHomePlatform } from './platform';
import { IMieleCharacteristic } from './mieleCharacteristics';

import EventSource from 'eventsource';

export enum MieleState {
  Off = 1,
  ProgramSelected = 3,
  WaitingToStart = 4,
  InUse = 5,
  Finished = 7,
  Cancelled = 9,
}

//-------------------------------------------------------------------------------------------------
// Interface Miele status response
//-------------------------------------------------------------------------------------------------
export interface MieleStatusResponseTemp {
  value_raw: number; value_localized: null|string; unit: string;
}

export interface MieleStatusResponse {
  status: {value_raw: number};
  programPhase: {value_raw: number};
  ventilationStep: {value_raw: number};
  remainingTime: number[];
  temperature: MieleStatusResponseTemp[];
  targetTemperature: MieleStatusResponseTemp[];
}

//-------------------------------------------------------------------------------------------------
// Class Base Miele Accessory
//-------------------------------------------------------------------------------------------------
enum ReconnectReason {
  Initial,
  Error,
  SelfInitiated,
  ServerConnectionLost
}

export abstract class MieleBasePlatformAccessory {
  private eventUrl = DEVICES_INFO_URL + '/' + this.accessory.context.device.uniqueId + '/events';
  protected mainService!: Service;
  protected characteristics: IMieleCharacteristic[] = [];
  private eventSource: EventSource | null = null;
  private reconnectReason = ReconnectReason.Initial;

  //-------------------------------------------------------------------------------------------------
  constructor(
    protected readonly platform: MieleAtHomePlatform,
    protected readonly accessory: PlatformAccessory,
  ) {

    // Set accessory information.
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Miele')
      .setCharacteristic(this.platform.Characteristic.Model, accessory.context.device.modelNumber)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, accessory.context.device.firmwareRevision)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.uniqueId)
      .getCharacteristic(this.platform.Characteristic.Identify)
      .on('set', this.identify.bind(this));

    this.connectToEventServer();

    let reconnectTimeout = this.platform.reconnectEventServerInterval;
    if(this.platform.reconnectEventServerInterval <=0) {
      this.platform.log.warn('Incorrect \'reconnectEventServerInterval\' specified in your configuration. '+
        `Value: ${reconnectTimeout} should be >0. Using default value ${DEFAULT_RECONNECT_EVENT_SERVER_INTERVAL_MIN}[min] instead.`);
      reconnectTimeout = DEFAULT_RECONNECT_EVENT_SERVER_INTERVAL_MIN;
    }

    const reconnectTimeoutMs= (reconnectTimeout*60*1000);
    setInterval(()=> {
      this.reconnectReason = ReconnectReason.SelfInitiated;
      this.connectToEventServer();
    }, reconnectTimeoutMs);
  }

  //-----------------------------------------------------------------------------------------------
  private connectToEventServer() {
    // Close previous
    if(this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    const config = this.platform.getHttpRequestConfig();
    config.headers['Authorization'] = this.platform.token?.getAccessToken();
    config.headers['Accept'] = 'text/event-stream';

    this.eventSource = new EventSource(this.eventUrl, config);

    // Data update.
    this.eventSource.addEventListener('device', (event) => {
      this.platform.log.debug(`${this.accessory.context.device.displayName}: Event '${event.type}' received.`);
      const data = JSON.parse(event['data']);
      this.update(data.state);
    });

    // Open success.
    this.eventSource.onopen = (_message) => {
      switch(this.reconnectReason) {
        case ReconnectReason.Initial:
          this.platform.log.info(`${this.accessory.context.device.displayName}: `+
            'Initial connection with Miele event server successfully established.');
          break;

        case ReconnectReason.Error:
          this.platform.log.info(`${this.accessory.context.device.displayName}: `+
            'Connection with Miele event server succesfully recovered from error.');
          break;
        
        case ReconnectReason.SelfInitiated:
          this.platform.log.info(`${this.accessory.context.device.displayName}: `+
            'Self initiated reconnect with Miele event server successful.');
          break;

        default:
        case ReconnectReason.ServerConnectionLost:
          this.platform.log.debug(`${this.accessory.context.device.displayName}: `+
            'Connection with Miele event server successfully recovered from stale server connection.');
          break;
      }
      
    };

    // Ping
    this.eventSource.addEventListener('ping', (_event) => {
      //this.platform.log.debug(`${this.accessory.context.device.displayName}: Event '${event.type}' received.`);
    });

    // Error handling.
    this.eventSource.onerror = (error) => {
      this.eventSource?.close();

      interface IError{  
        message: string; 
        status: number;
        type: string; 
      }  

      const errorObj = (<IError><unknown>error);

      // If Miele closed the connection on their end, EventSource raises an empty error object.
      if(!errorObj.status) {
        this.platform.log.debug(`${this.accessory.context.device.displayName}: Miele event server `+
          `connection lost. Auto-reconnect after ${EVENT_SERVER_RECONNECT_DELAY_S}[s]`);
        this.reconnectReason = ReconnectReason.ServerConnectionLost;

      } else {
        this.platform.log.error(`${this.accessory.context.device.displayName}: Error received from Miele event server. `+
           `Status: ${errorObj.status}. Message: '${errorObj.message}'`);
        this.mainService.setCharacteristic(this.platform.Characteristic.StatusFault,
          this.platform.Characteristic.StatusFault.GENERAL_FAULT);

        this.platform.log.info(`${this.accessory.context.device.displayName}: Will attempt to reconnect to the Miele event server after`+
          ` ${EVENT_SERVER_RECONNECT_DELAY_S}[s].`);
        
        this.reconnectReason = ReconnectReason.Error;
      }
      
      setTimeout(()=> {
        this.connectToEventServer();
      }, EVENT_SERVER_RECONNECT_DELAY_S*1000);
    };

  }

  //-----------------------------------------------------------------------------------------------
  protected identify(_value: CharacteristicValue, _callback: CharacteristicSetCallback) {
    this.platform.log.info(`Identify requested for: ${this.accessory.context.device.displayName} `+
      `(${this.accessory.context.device.modelNumber}) `+
      `with serial number: ${this.accessory.context.device.uniqueId}`);
  }

  //-----------------------------------------------------------------------------------------------
  // Update all characteristics
  protected update(deviceData: MieleStatusResponse): void {
    for(const characteristic of this.characteristics) {
      characteristic.update(deviceData);
    }

    this.mainService.setCharacteristic(this.platform.Characteristic.StatusFault, this.platform.Characteristic.StatusFault.NO_FAULT);
  }

}
