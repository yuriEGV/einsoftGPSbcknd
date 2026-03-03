/**
 * Motor Cut Driver / Engine Stop Controller
 * Handles remote engine immobilization with intelligent rules
 */

class MotorCutDriver {
  constructor(config = {}) {
    this.relayPin = config.relayPin || 'GPIO12';
    this.fuelPumpRelay = config.fuelPumpRelay || 'GPIO13';
    this.ignitionPin = config.ignitionPin || 'GPIO14';
    this.safetyDelay = config.safetyDelay || 2000; // ms before cut activates
    this.cutActive = false;
    this.rules = [];
  }

  // Set motor cut rules (geofence-based, time-based, etc.)
  setRules(rules) {
    this.rules = rules;
    console.log(`🚗 Motor cut rules updated: ${rules.length} rule(s)`);
  }

  // Check if any rule triggers motor cut
  async shouldActivateCut() {
    for (const rule of this.rules) {
      if (!rule.active) continue;

      // Time-based check
      const currentTime = new Date();
      const currentHour = currentTime.getHours();
      const currentMinutes = currentTime.getMinutes();
      const currentDay = currentTime.getDay();

      const fromTime = rule.conditions.timeFrom?.split(':') || [0, 0];
      const toTime = rule.conditions.timeTo?.split(':') || [23, 59];

      const fromMinutes = parseInt(fromTime[0]) * 60 + parseInt(fromTime[1]);
      const toMinutes = parseInt(toTime[0]) * 60 + parseInt(toTime[1]);
      const currentMinutesToday = currentHour * 60 + currentMinutes;

      const timeMatch = currentMinutesToday >= fromMinutes && currentMinutesToday <= toMinutes;
      const dayMatch = rule.conditions.dayOfWeek?.includes(currentDay) || rule.conditions.dayOfWeek?.length === 0;

      if (timeMatch && dayMatch) {
        return true;
      }
    }

    return false;
  }

  // Activate motor cut (cut fuel/ignition)
  async activateMotorCut() {
    try {
      console.log('🔴 Activating motor cut...');

      // Safety delay - give driver time to reach safe location
      await this.delay(this.safetyDelay);

      // Cut fuel pump first
      await this.setRelay(this.fuelPumpRelay, true);
      await this.delay(500);

      // Then cut ignition
      await this.setRelay(this.ignitionPin, true);

      this.cutActive = true;
      return {
        success: true,
        message: 'Motor cut activated',
        timestamp: new Date(),
      };
    } catch (error) {
      console.error('Error activating motor cut:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // Deactivate motor cut (restore fuel/ignition)
  async deactivateMotorCut() {
    try {
      console.log('🟢 Deactivating motor cut...');

      // Restore ignition
      await this.setRelay(this.ignitionPin, false);
      await this.delay(500);

      // Restore fuel pump
      await this.setRelay(this.fuelPumpRelay, false);

      this.cutActive = false;
      return {
        success: true,
        message: 'Motor cut deactivated',
        timestamp: new Date(),
      };
    } catch (error) {
      console.error('Error deactivating motor cut:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // Graceful stop (engine shutdown without jerking)
  async gracefulStop() {
    try {
      console.log('⏹️  Initiating graceful stop...');

      // Gradually reduce ignition voltage instead of hard cut
      for (let i = 100; i >= 0; i -= 10) {
        await this.setPWM(this.ignitionPin, i);
        await this.delay(200);
      }

      this.cutActive = true;
      return { success: true };
    } catch (error) {
      console.error('Error during graceful stop:', error);
      return { success: false, error: error.message };
    }
  }

  // Set relay state (GPIO)
  async setRelay(pin, state) {
    // This would interface with GPIO controller
    console.log(`  Relay ${pin}: ${state ? 'ON' : 'OFF'}`);
    return true;
  }

  // PWM control for gradual shutdown
  async setPWM(pin, dutyCycle) {
    // Implement PWM control
    console.log(`  PWM ${pin}: ${dutyCycle}%`);
    return true;
  }

  // Utility delay
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Get motor cut status
  getStatus() {
    return {
      active: this.cutActive,
      rules: this.rules,
    };
  }
}

export default MotorCutDriver;
