import { decodePath } from '@googlemaps/polyline-codec';
import * as turf from '@turf/turf';

export function polylineToLineString(encodedPolyline) {
    // Decodifica la polilinea di Google in un array di [lat, lng]
    const coords = decodePath(encodedPolyline).map(c => [c[1], c[0]]); // Inverte in [lon, lat]
    return turf.lineString(coords);
}