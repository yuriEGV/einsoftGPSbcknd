import Company from '../src/models/Company.js';
import User from '../src/models/User.js';
import PanicAlert from '../src/models/PanicAlert.js';
import Vehicle from '../src/models/Vehicle.js';

describe('Mongoose Models Unit Tests', () => {
  describe('Company Model', () => {
    it('should create a valid company instance', () => {
      const companyData = {
        name: 'Einsoft Logistics',
        email: 'info@einsoft.com',
        phone: '+18005550199',
        subscriptionPlan: 'pro',
      };
      const company = new Company(companyData);
      expect(company.name).toBe('Einsoft Logistics');
      expect(company.subscriptionPlan).toBe('pro');
      expect(company.isActive).toBe(true);
    });

    it('should require name', () => {
      const company = new Company({});
      const err = company.validateSync();
      expect(err.errors.name).toBeDefined();
    });
  });

  describe('User Model', () => {
    it('should create a valid user instance with default role', () => {
      const userData = {
        name: 'Carlos Gomez',
        email: 'carlos@einsoft.com',
        password: 'hashedpassword123',
      };
      const user = new User(userData);
      expect(user.name).toBe('Carlos Gomez');
      expect(user.role).toBe('independent');
    });

    it('should validate role enum', () => {
      const user = new User({
        name: 'Ana R',
        email: 'ana@einsoft.com',
        password: 'pass',
        role: 'invalid_role',
      });
      const err = user.validateSync();
      expect(err.errors.role).toBeDefined();
    });
  });

  describe('PanicAlert Model', () => {
    it('should create a panic alert with ACTIVE status default', () => {
      const panicData = {
        source: 'vehicle',
        latitude: 18.4861,
        longitude: -69.9312,
        address: 'Av. Winston Churchill',
        speed: 45,
      };
      const panicAlert = new PanicAlert(panicData);
      expect(panicAlert.source).toBe('vehicle');
      expect(panicAlert.status).toBe('ACTIVE');
      expect(panicAlert.speed).toBe(45);
    });

    it('should require source field', () => {
      const panicAlert = new PanicAlert({});
      const err = panicAlert.validateSync();
      expect(err.errors.source).toBeDefined();
    });
  });

  describe('Vehicle Model', () => {
    it('should instantiate vehicle with default status offline', () => {
      const vehicleData = {
        licensePlate: 'A-12345',
        make: 'Toyota',
        model: 'Hilux',
        year: 2022,
      };
      const vehicle = new Vehicle(vehicleData);
      expect(vehicle.licensePlate).toBe('A-12345');
      expect(vehicle.status).toBe('offline');
    });
  });
});
