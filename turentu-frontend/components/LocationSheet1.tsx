'use client';

import { usePlacesAutocomplete, PlaceResult } from "../hooks/usePlacesAutocomplete";

interface Coord {
  lat: number;
  lon: number;
}

interface Props {
  query: string;
  setQuery: (q: string) => void;
  onClose: () => void;
  onSelect: (val: { nome: string; coord: Coord }) => void;
}

export default function LocationSheet({ query, setQuery, onClose, onSelect }: Props) {
  const { results, loading } = usePlacesAutocomplete(query);

  const handleSelect = (place: PlaceResult) => {
    const geocoder = new (window as any).google.maps.Geocoder();
    geocoder.geocode({ placeId: place.place_id }, (res: any[], status: string) => {
      if (status !== "OK" || !res.length) {
        alert("Errore geocoding");
        return;
      }
      const loc = res[0].geometry.location;
      onSelect({ nome: place.description, coord: { lat: loc.lat(), lon: loc.lng() } });
      onClose();
    });
  };

  return (
    <div className="flex flex-col gap-2 overflow-y-auto">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Cerca località..."
        className="w-full border rounded p-2 mb-2"
      />

      {loading && <p>Caricamento...</p>}
      {!loading && results.length === 0 && query.length >= 3 && <p>Nessun risultato trovato</p>}

      <ul className="flex flex-col gap-1">
        {results.map((place) => (
          <li
            key={place.place_id}
            className="p-2 hover:bg-gray-100 cursor-pointer rounded"
            onClick={() => handleSelect(place)}
          >
            {place.description}
          </li>
        ))}
      </ul>
    </div>
  );
}
