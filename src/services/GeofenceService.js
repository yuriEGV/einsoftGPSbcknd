/**
 * Geofence Service
 * Manages geofence checking and event triggers
 */

import mongoose from 'mongoose';
import Geofence from '../models/Geofence.js';
import Vehicle from '../models/Vehicle.js';
import Alert from '../models/Alert.js';

class GeofenceService {
  // Check if point is inside polygon using ray casting algorithm
  isPointInPolygon(point, polygon) {
    const [x, y] = point;
    let inside = false;

    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];

      const intersect = ((yi > y) !== (yj > y))
        && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);

      if (intersect) inside = !inside;
    }

    return inside;
  }

  // Check if point is inside circle
  isPointInCircle(point, center, radius) {
    const [px, py] = point;
    const [cx, cy] = center;

    const distance = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
    return distance <= (radius / 111000); // Convert meters to degrees
  }

  // Check if vehicle violates any geofence
  async checkGeofenceViolation(vehicle) {
    const geofences = await Geofence.find({
      assignedVehicles: vehicle._id,
      active: true,
    });

    const violations = [];
    const vehiclePoint = [
      vehicle.location.coordinates[0], // longitude
      vehicle.location.coordinates[1], // latitude
    ];

    for (const geofence of geofences) {
      let isInside = false;

      if (geofence.geometry.type === 'Polygon') {
        isInside = this.isPointInPolygon(vehiclePoint, geofence.geometry.coordinates[0]);
      } else if (geofence.geometry.type === 'Circle') {
        isInside = this.isPointInCircle(vehiclePoint, geofence.center.coordinates, geofence.radius);
      }

      // Determine if this is entry or exit
      const wasInside = geofence.lastVehicleState?.[vehicle._id];
      const isEntry = !wasInside && isInside;
      const isExit = wasInside && !isInside;

      if ((isEntry && geofence.alerts.onEntry) || (isExit && geofence.alerts.onExit)) {
        violations.push({
          geofenceId: geofence._id,
          geofenceName: geofence.name,
          type: isEntry ? 'entry' : 'exit',
          severity: 'medium',
          coordinates: vehiclePoint,
        });

        // Update geofence state
        if (!geofence.lastVehicleState) {
          geofence.lastVehicleState = {};
        }
        geofence.lastVehicleState[vehicle._id] = isInside;
        await geofence.save();
      }

      // Check speed limit within geofence
      if (isInside && geofence.speed_limit && vehicle.speed > geofence.speed_limit) {
        violations.push({
          geofenceId: geofence._id,
          geofenceName: geofence.name,
          type: 'speed_violation',
          severity: 'high',
          currentSpeed: vehicle.speed,
          speedLimit: geofence.speed_limit,
        });
      }
    }

    return violations;
  }

  // Create alert for geofence violation
  async createGeofenceAlert(vehicle, violation) {
    const alert = new Alert({
      vehicle: vehicle._id,
      type: `geofence_${violation.type}`,
      severity: violation.severity,
      message: `Vehicle ${vehicle.licensePlate} ${violation.type} geofence "${violation.geofenceName}"`,
      location: {
        latitude: vehicle.location.coordinates[1],
        longitude: vehicle.location.coordinates[0],
        address: vehicle.location.address,
      },
      geofence: violation.geofenceId,
      driver: vehicle.driver,
    });

    await alert.save();
    return alert;
  }

  // Batch check all vehicles against geofences
  async checkAllVehicles(companyId) {
    const vehicles = await Vehicle.find({ company: companyId });
    const alertsCreated = [];

    for (const vehicle of vehicles) {
      const violations = await this.checkGeofenceViolation(vehicle);

      for (const violation of violations) {
        const alert = await this.createGeofenceAlert(vehicle, violation);
        alertsCreated.push(alert);
      }
    }

    return alertsCreated;
  }
}

export default new GeofenceService();
