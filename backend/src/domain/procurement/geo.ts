import { Prisma } from '@prisma/client';

export interface Coordinates {
  latitude: Prisma.Decimal | number | null;
  longitude: Prisma.Decimal | number | null;
}

/**
 * Calculates geographic great-circle distance between two coordinates in kilometers
 * using the deterministic Haversine formula.
 */
export function calculateDistanceKm(
  pointA: Coordinates,
  pointB: Coordinates
): number {
  if (
    pointA.latitude === null ||
    pointA.longitude === null ||
    pointB.latitude === null ||
    pointB.longitude === null
  ) {
    // If coordinates are missing, assume neutral baseline 0.0 km
    return 0.0;
  }

  const lat1 = typeof pointA.latitude === 'number' ? pointA.latitude : Number(pointA.latitude);
  const lon1 = typeof pointA.longitude === 'number' ? pointA.longitude : Number(pointA.longitude);
  const lat2 = typeof pointB.latitude === 'number' ? pointB.latitude : Number(pointB.latitude);
  const lon2 = typeof pointB.longitude === 'number' ? pointB.longitude : Number(pointB.longitude);

  const R = 6371; // Earth's mean radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  // Round to 2 decimal places
  return Math.round(distance * 100) / 100;
}

