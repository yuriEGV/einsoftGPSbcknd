/**
 * Eco-Driving Score Calculator & AI Module
 * Analyzes driving behavior and generates efficiency scores
 */

class EcoDrivingModule {
  constructor(config = {}) {
    this.maxSpeed = config.maxSpeed || 120;
    this.optimalSpeed = config.optimalSpeed || 80;
    this.idleTimeThreshold = config.idleTimeThreshold || 300; // seconds
  }

  // Calculate eco-score based on multiple factors
  async calculateEcoScore(drivingData) {
    let score = 100; // Start with perfect score

    const weights = {
      speeding: 0.25,
      hardAcceleration: 0.20,
      hardBraking: 0.20,
      idleTime: 0.15,
      fuelConsumption: 0.20,
    };

    // Penalize speeding
    if (drivingData.avgSpeed > this.optimalSpeed) {
      const speedPenalty = ((drivingData.avgSpeed - this.optimalSpeed) / this.optimalSpeed) * 30;
      score -= Math.min(speedPenalty, weights.speeding * 100);
    }

    // Penalize hard accelerations
    if (drivingData.hardAccelerations > 5) {
      const accelPenalty = Math.min(drivingData.hardAccelerations * 2, weights.hardAcceleration * 100);
      score -= accelPenalty;
    }

    // Penalize hard braking
    if (drivingData.hardBrakings > 5) {
      const brakePenalty = Math.min(drivingData.hardBrakings * 2, weights.hardBraking * 100);
      score -= brakePenalty;
    }

    // Penalize idle time
    if (drivingData.idleTime > this.idleTimeThreshold) {
      const idlePenalty = Math.min((drivingData.idleTime / 60) * 0.5, weights.idleTime * 100);
      score -= idlePenalty;
    }

    // Penalize high fuel consumption
    if (drivingData.avgConsumption > 12) {
      const fuelPenalty = ((drivingData.avgConsumption - 8) / 8) * 20;
      score -= Math.min(fuelPenalty, weights.fuelConsumption * 100);
    }

    return Math.max(0, Math.min(100, score));
  }

  // Calculate driver ranking compared to fleet average
  async calculateDriverRanking(driverScore, fleetAverageScore) {
    const percentageDiff = ((fleetAverageScore - driverScore) / fleetAverageScore) * 100;

    let rank = 'Average';
    if (percentageDiff > 15) {
      rank = 'Excellent';
    } else if (percentageDiff > 5) {
      rank = 'Good';
    } else if (percentageDiff < -15) {
      rank = 'Needs Improvement';
    } else if (percentageDiff < -5) {
      rank = 'Below Average';
    }

    return {
      rank,
      percentageDiff: percentageDiff.toFixed(2),
      efficiency: (percentageDiff > 0 ? 'More' : 'Less') + ` efficient than fleet average`,
    };
  }

  // Generate personalized recommendations
  generateRecommendations(drivingData) {
    const recommendations = [];

    if (drivingData.avgSpeed > this.optimalSpeed) {
      recommendations.push({
        priority: 'high',
        message: `Reduce average speed from ${drivingData.avgSpeed.toFixed(1)} to ${this.optimalSpeed} km/h to save fuel`,
        impact: 'Potential 15% fuel savings',
      });
    }

    if (drivingData.hardAccelerations > 10) {
      recommendations.push({
        priority: 'high',
        message: 'Smoother acceleration detected would reduce wear and fuel consumption',
        impact: 'Potential 10% fuel savings + engine longevity',
      });
    }

    if (drivingData.hardBrakings > 10) {
      recommendations.push({
        priority: 'medium',
        message: 'Practice gentler braking and anticipate stops in advance',
        impact: 'Brake pad longevity +20%, Passenger comfort improved',
      });
    }

    if (drivingData.idleTime > this.idleTimeThreshold) {
      recommendations.push({
        priority: 'medium',
        message: `Reduce idle time (currently ${(drivingData.idleTime / 60).toFixed(1)} minutes)`,
        impact: 'Potential 5% fuel savings',
      });
    }

    return recommendations;
  }

  // Estimate fuel savings potential
  estimateSavings(drivingData, timeframe = 'monthly') {
    // Baseline assumptions
    const avgFuelPrice = 1.50; // per liter
    const currentConsumption = drivingData.avgConsumption || 10;
    const currentDistance = drivingData.monthlyDistance || 2000;

    // Calculate current cost
    const currentCost = (currentDistance / 100) * currentConsumption * avgFuelPrice;

    // Estimate optimized consumption (with eco-driving: -15%)
    const optimizedConsumption = currentConsumption * 0.85;
    const optimizedCost = (currentDistance / 100) * optimizedConsumption * avgFuelPrice;

    const savings = currentCost - optimizedCost;
    const percentage = ((currentConsumption - optimizedConsumption) / currentConsumption) * 100;

    return {
      currentCost: currentCost.toFixed(2),
      optimizedCost: optimizedCost.toFixed(2),
      potentialSavings: savings.toFixed(2),
      percentage: percentage.toFixed(1),
      timeframe,
    };
  }

  // Analyze trip for eco-score
  async analyzeTrip(tripData) {
    const ecoScore = await this.calculateEcoScore(tripData);
    const recommendations = this.generateRecommendations(tripData);
    const savings = this.estimateSavings(tripData);

    return {
      ecoScore: ecoScore.toFixed(1),
      recommendations,
      potentialSavings: savings,
      timestamp: new Date(),
    };
  }

  // AI Prediction: Estimate next month's fuel cost
  predictNextMonthCost(historicalData) {
    const avgMonthlyConsumption = historicalData.avgMonthlyConsumption || 100;
    const pricePerLiter = 1.50;

    const predictedCost = avgMonthlyConsumption * pricePerLiter;
    const trend = historicalData.trend || 'stable'; // up, down, stable

    return {
      predictedMonthlyFuelCost: predictedCost.toFixed(2),
      trend,
      confidence: '85%',
    };
  }
}

export default EcoDrivingModule;
