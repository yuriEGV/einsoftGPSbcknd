import axios from 'axios';

const API_URL = 'https://einsoft-gp-sbcknd.vercel.app/api';
const IMEI = 'SIMULATOR_001';

// Starting point (Santiago Centro)
let lat = -33.4372;
let lng = -70.6506;

const simulateMovement = async () => {
    console.log(`🚀 Starting simulation for IMEI: ${IMEI}...`);

    setInterval(async () => {
        // Small random move
        lat += (Math.random() - 0.5) * 0.001;
        lng += (Math.random() - 0.5) * 0.001;
        const speed = Math.floor(Math.random() * 60) + 20;

        try {
            await axios.post(`${API_URL}/sensors/upload`, {
                deviceIMEI: IMEI,
                gps: {
                    latitude: lat,
                    longitude: lng,
                    speed: speed,
                    heading: Math.floor(Math.random() * 360)
                },
                fuel: { level: Math.floor(Math.random() * 20) + 70 },
                battery: { voltage: 12.6 }
            });
            console.log(`📍 Position updated: ${lat.toFixed(4)}, ${lng.toFixed(4)} | Speed: ${speed} km/h`);
        } catch (error) {
            console.error('❌ Upload failed:', error.response?.data || error.message);
        }
    }, 5000); // Every 5 seconds
};

simulateMovement();
