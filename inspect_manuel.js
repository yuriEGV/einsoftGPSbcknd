import mongoose from 'mongoose';

async function main() {
  const uri = 'mongodb+srv://yguajardov:maquina123@comercioelectronico.c6vj7t7.mongodb.net/EinsoftGPS?appName=EinstoreGPS';
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log('Connected to MongoDB');

  const PersonTracker = mongoose.model('PersonTracker', new mongoose.Schema({}, { strict: false }));
  const SensorData = mongoose.model('SensorData', new mongoose.Schema({}, { strict: false }));
  const Vehicle = mongoose.model('Vehicle', new mongoose.Schema({}, { strict: false }));

  const people = await PersonTracker.find({}).lean();
  console.log('--- ALL PEOPLE TRACKERS ---');
  people.forEach(p => {
    console.log(`Name: ${p.name}, phone: ${p.phone}, deviceId: ${p.deviceId}, trackerCode: ${p.trackerCode}, hasReportedLocation: ${p.hasReportedLocation}, coords: ${JSON.stringify(p.location?.coordinates)}, timestamp: ${p.location?.timestamp}`);
  });

  const recentSensors = await SensorData.find({}).sort({ timestamp: -1 }).limit(20).lean();
  console.log('--- RECENT SENSOR DATA (last 20) ---');
  recentSensors.forEach(s => {
    console.log(`deviceIMEI: ${s.deviceIMEI}, personTracker: ${s.personTracker}, vehicle: ${s.vehicle}, gps: [${s.gps?.latitude}, ${s.gps?.longitude}], time: ${s.timestamp}`);
  });

  const vehicles = await Vehicle.find({}).lean();
  console.log('--- ALL VEHICLES ---');
  vehicles.forEach(v => {
    console.log(`Plate: ${v.licensePlate}, IMEI: ${v.deviceIMEI}, coords: ${JSON.stringify(v.location?.coordinates)}, lastUpdate: ${v.lastUpdate}`);
  });

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
