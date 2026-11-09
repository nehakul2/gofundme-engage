declare module 'zipcodes' {
  interface Zip { zip: string; latitude: number; longitude: number; city: string; state: string; country: string }
  export function lookup(zip: string | number): Zip | undefined;
  export function lookupByCoords(lat: number, lng: number): Zip | undefined;
}
