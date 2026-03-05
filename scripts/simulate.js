import axios from 'axios';

const API_URL = 'https://einsoft-gp-sbcknd.vercel.app/api/sensors/upload';
const IMEIS = ['SIMULATOR_001', 'SIMULATOR_002'];

// Santiago de Chile coordinates (starting point)
const baseLocation = {
    lat: -33.4372,
    lon: -70.6506
};

const moveVehicle = async (imei, index) => {
    // Slight random movement
    const lat = baseLocation.lat + (Math.random() - 0.5) * 0.01;
    const lon = baseLocation.lon + (Math.random() - 0.5) * 0.01;
    const speed = Math.floor(Math.random() * 60) + 20; // 20-80 km/h

    const payload = {
        deviceIMEI: imei,
        gps: {
            latitude: lat,
            longitude: lon,
            speed: speed,
            heading: Math.floor(Math.random() * 360),
            altitude: 500,
            satellites: 12
        },
        fuel: {
            level: 75 - (index * 5)
        },
        temperature: {
            ambient: 25,
            engine: 85
        }
    };

    try {
        const response = await axios.post(API_URL, payload);
        console.log(`[${imei}] Location Update OK: ${lat.toFixed(4)}, ${lon.toFixed(4)} @ ${speed} km/h`);
    } catch (error) {
        console.error(`[${imei}] Update Failed:`, error.response?.data || error.message);
    }
};

console.log('🚀 Starting GPS Movement Simulator...');
console.log('Setting vehicles to roam around Santiago Centro.');

setInterval(() => {
    IMEIS.forEach((imei, idx) => moveVehicle(imei, idx));
}, 5000); // Update every 5 seconds
