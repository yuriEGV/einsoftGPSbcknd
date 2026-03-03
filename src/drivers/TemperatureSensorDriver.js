/**
 * Temperature Sensor Driver
 * Monitors ambient, engine, and cargo temperatures
 */

class TemperatureSensorDriver {
  constructor(config = {}) {
    this.ambientSensorPin = config.ambientSensorPin || 'A1';
    this.engineSensorPin = config.engineSensorPin || 'A2';
    this.cargoSensorPin = config.cargoSensorPin || 'A3';
    this.alertThresholds = config.alertThresholds || {
      engineHighTemp: 110, // Celsius
      cargoHighTemp: 25,
      cargoLowTemp: 2,
      engineLowTemp: -10,
    };
  }

  // Read temperature from sensor (generic analog reading)
  async readTemperature(sensorPin) {
    try {
      // ADC reading converted to temperature
      // For thermistor: Temperature = 1/(A + B*ln(R) + C*ln(R)^3) - 273.15
      // Simplified placeholder
      return 20 + Math.random() * 10;
    } catch (error) {
      console.error('Error reading temperature sensor:', error);
      return null;
    }
  }

  // Read ambient temperature
  async readAmbientTemp() {
    return await this.readTemperature(this.ambientSensorPin);
  }

  // Read engine/coolant temperature
  async readEngineTemp() {
    return await this.readTemperature(this.engineSensorPin);
  }

  // Read cargo temperature (for refrigerated vehicles)
  async readCargoTemp() {
    return await this.readTemperature(this.cargoSensorPin);
  }

  // Check for temperature alerts
  async checkAlerts() {
    const engineTemp = await this.readEngineTemp();
    const cargoTemp = await this.readCargoTemp();

    const alerts = [];

    if (engineTemp > this.alertThresholds.engineHighTemp) {
      alerts.push({
        type: 'engine_overheating',
        severity: 'high',
        value: engineTemp,
        threshold: this.alertThresholds.engineHighTemp,
      });
    }

    if (cargoTemp > this.alertThresholds.cargoHighTemp) {
      alerts.push({
        type: 'cargo_temperature_high',
        severity: 'medium',
        value: cargoTemp,
        threshold: this.alertThresholds.cargoHighTemp,
      });
    }

    if (cargoTemp < this.alertThresholds.cargoLowTemp) {
      alerts.push({
        type: 'cargo_temperature_low',
        severity: 'medium',
        value: cargoTemp,
        threshold: this.alertThresholds.cargoLowTemp,
      });
    }

    return alerts;
  }

  // Get all temperature data
  async readAllData() {
    const ambientTemp = await this.readAmbientTemp();
    const engineTemp = await this.readEngineTemp();
    const cargoTemp = await this.readCargoTemp();
    const alerts = await this.checkAlerts();

    return {
      ambient: ambientTemp,
      engine: engineTemp,
      cargo: cargoTemp,
      alerts,
      timestamp: new Date(),
    };
  }
}

export default TemperatureSensorDriver;
