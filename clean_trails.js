import mongoose from 'mongoose';

async function main() {
  const uri = 'mongodb+srv://yguajardov:maquina123@comercioelectronico.c6vj7t7.mongodb.net/EinsoftGPS?appName=EinstoreGPS';
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log('Connected to MongoDB');

  const PersonTracker = mongoose.model('PersonTracker', new mongoose.Schema({}, { strict: false }));
  const SensorData = mongoose.model('SensorData', new mongoose.Schema({}, { strict: false }));

  // 1. Delete all SensorData records for person trackers
  const dSensors = await SensorData.deleteMany({
    $or: [
      { personTracker: { $exists: true, $ne: null } },
      { deviceIMEI: { $in: ['866140042278017', '350673971668546', 'MOVIL-3550', 'PER-139F17', 'PER-FAEFB9', 'PER-FC9B50', 'PER-5CA27E'] } }
    ]
  });
  console.log('Deleted old sensor data points:', dSensors.deletedCount);

  // 2. Reset all person trackers so no fake points or old points from yesterday remain
  const res = await PersonTracker.updateMany(
    {},
    {
      $set: {
        location: {
          type: 'Point',
          coordinates: [0, 0],
          address: 'Esperando conexión satelital del teléfono...',
          timestamp: new Date(),
        },
        hasReportedLocation: false,
        status: 'normal',
        'panicAlert.active': false,
      }
    }
  );
  console.log('Reset person trackers to clean state:', res.modifiedCount);

  await mongoose.disconnect();
  console.log('Done!');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
