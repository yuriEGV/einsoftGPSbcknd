import 'dotenv/config';
import mongoose from 'mongoose';

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  // 1. Link Yuri's device ID
  const resYuri = await mongoose.connection.collection('persontrackers').updateOne(
    { name: 'yuri' },
    {
      $set: {
        deviceId: '866140042278017',
        lastSeen: new Date(),
        hasReportedLocation: true,
        status: 'normal',
      }
    }
  );
  console.log('Linked Yuri device ID 866140042278017:', resYuri.modifiedCount);

  // 2. Resolve all old test panics
  const resPanics = await mongoose.connection.collection('panicalerts').updateMany(
    { status: 'ACTIVE' },
    { $set: { status: 'RESOLVED', resolvedAt: new Date() } }
  );
  console.log('Resolved active panics:', resPanics.modifiedCount);

  // 3. Acknowledge old alerts
  const resAlerts = await mongoose.connection.collection('alerts').updateMany(
    { acknowledged: false },
    { $set: { acknowledged: true } }
  );
  console.log('Acknowledged alerts:', resAlerts.modifiedCount);

  // 4. Reset people panic status
  const resPeople = await mongoose.connection.collection('persontrackers').updateMany(
    {},
    { $set: { 'panicAlert.active': false, status: 'normal' } }
  );
  console.log('Reset person statuses to normal:', resPeople.modifiedCount);

  await mongoose.disconnect();
  console.log('Done!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
