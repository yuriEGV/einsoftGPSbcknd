import GeofenceService from '../src/services/GeofenceService.js';
import EcoDrivingModule from '../src/services/EcoDrivingModule.js';

describe('Backend Services Unit Tests', () => {
  describe('GeofenceService', () => {
    it('should accurately test point inside polygon using ray casting', () => {
      // Square polygon around [0,0] to [10,10]
      const polygon = [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ];

      const insidePoint = [5, 5];
      const outsidePoint = [15, 15];

      expect(GeofenceService.isPointInPolygon(insidePoint, polygon)).toBe(true);
      expect(GeofenceService.isPointInPolygon(outsidePoint, polygon)).toBe(false);
    });

    it('should accurately test point inside circle radius', () => {
      const center = [-69.9312, 18.4861]; // Santo Domingo coordinates
      const radiusMeters = 500; // 500m

      const pointInside = [-69.9315, 18.4863];
      const pointFarAway = [-70.5000, 19.5000];

      expect(GeofenceService.isPointInCircle(pointInside, center, radiusMeters)).toBe(true);
      expect(GeofenceService.isPointInCircle(pointFarAway, center, radiusMeters)).toBe(false);
    });
  });

  describe('EcoDrivingModule', () => {
    let ecoModule;

    beforeEach(() => {
      ecoModule = new EcoDrivingModule();
    });

    it('should calculate eco score correctly from driving data', async () => {
      const drivingData = {
        avgSpeed: 75,
        hardAccelerations: 2,
        hardBrakings: 1,
        idleTime: 120,
        avgConsumption: 9.5,
      };

      const score = await ecoModule.calculateEcoScore(drivingData);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('should generate recommendations when thresholds are exceeded', () => {
      const drivingData = {
        avgSpeed: 95,
        hardAccelerations: 12,
        hardBrakings: 11,
        idleTime: 500,
        avgConsumption: 14,
      };

      const recs = ecoModule.generateRecommendations(drivingData);
      expect(recs.length).toBeGreaterThan(0);
      expect(recs[0]).toHaveProperty('message');
    });
  });
});
