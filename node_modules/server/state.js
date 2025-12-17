import { nanoid } from "nanoid";

export function createInitialState() {
  return {
    zones: [
      { id: "castle-byers", name: "Castle Byers" },
      { id: "starcourt-ruins", name: "Starcourt Ruins" },
      { id: "pumpkin-fields", name: "Rotten Pumpkin Fields" },
      { id: "creel-house", name: "Creel House Perimeter" }
    ],
    camps: [
      {
        id: "camp-hawkins-high",
        name: "Hawkins High Gym Relief Camp",
        status: "safe",
        location: { lat: 40.134, lng: -85.668 },
        resources: { food: 72, water: 81, medical: 34, power: 62 }
      },
      {
        id: "camp-forest-line",
        name: "Forest Line Safe Camp",
        status: "watch",
        location: { lat: 40.12, lng: -85.64 },
        resources: { food: 41, water: 57, medical: 18, power: 39 }
      },
      {
        id: "camp-quarry",
        name: "Old Quarry Outpost",
        status: "critical",
        location: { lat: 40.155, lng: -85.705 },
        resources: { food: 19, water: 23, medical: 7, power: 21 }
      }
    ],

    users: new Map(),

    zoneMessages: new Map(),
    zonePresence: new Map(),
    sosAlerts: [],
    threats: [],

    makeId: () => nanoid(10)
  };
}
