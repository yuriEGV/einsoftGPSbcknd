/**
 * Fuel Sensor Driver
 * Reads fuel level and consumption from fuel tank sensors
 */

class FuelSensorDriver {
  constructor(config = {}) {
    this.analogInputPin = config.pin || 'A0';
    this.calibrationEmpty = config.calibrationEmpty || 0;
    this.calibrationFull = config.calibrationFull || 1023;
    this.tankCapacity = config.tankCapacity || 60; // liters
    this.previousReading = null;
    this.previousTimestamp = null;
  }

  // Read raw analog value
  async readRawValue() {
    try {
      // This would interface with microcontroller ADC
      // Placeholder implementation
      return Math.random() * 1023;
    } catch (error) {
      console.error('Error reading fuel sensor:', error);
      return null;
    }
  }

  // Convert raw value to fuel level percentage
  async readFuelLevel() {
    try {
      const rawValue = await this.readRawValue();
      if (rawValue === null) return null;

      // Linear interpolation
      const level = ((rawValue - this.calibrationEmpty) / (this.calibrationFull - this.calibrationEmpty)) * 100;
      return Math.max(0, Math.min(100, level));
    } catch (error) {
      console.error('Error calculating fuel level:', error);
      return null;
    }
  }

  // Get fuel level in liters
  async readFuelLiters() {
    try {
      const percentage = await this.readFuelLevel();
      if (percentage === null) return null;

      return (percentage / 100) * this.tankCapacity;
    } catch (error) {
      console.error('Error reading fuel in liters:', error);
      return null;
    }
  }

  // Calculate fuel consumption (liters per 100km)
  async readConsumption(speed) {
    try {
      const currentLevel = await this.readFuelLevel();
      const now = new Date();

      if (!this.previousReading || !this.previousTimestamp || speed <= 0) {
        this.previousReading = currentLevel;
        this.previousTimestamp = now;
        return 0;
      }

      const timeDiff = (now - this.previousTimestamp) / 1000 / 3600; // hours
      const fuelUsed = this.previousReading - currentLevel;
      const distance = speed * timeDiff; // km

      if (distance === 0) return 0;

      const consumption = (fuelUsed / distance) * 100; // liters per 100km

      this.previousReading = currentLevel;
      this.previousTimestamp = now;

      return Math.max(0, consumption);
    } catch (error) {
      console.error('Error calculating consumption:', error);
      return 0;
    }
  }

  // Alert if fuel is low
  isLowFuel(threshold = 15) {
    return this.previousReading < threshold;
  }

  // Estimate range based on consumption
  async estimateRange(consumption) {
    try {
      const currentLevel = await this.readFuelLevel();
      if (currentLevel === null || consumption === 0) return 0;

      const fuelLiters = (currentLevel / 100) * this.tankCapacity;
      const rangeKm = (fuelLiters / consumption) * 100;

      return rangeKm;
    } catch (error) {
      console.error('Error estimating range:', error);
      return 0;
    }
  }

  // Get all fuel data
  async readAllData() {
    const level = await this.readFuelLevel();

    return {
      level: level,
      liters: (level / 100) * this.tankCapacity,
      lowFuel: level < 15,
      timestamp: new Date(),
    };
  }
}

export default FuelSensorDriver;
