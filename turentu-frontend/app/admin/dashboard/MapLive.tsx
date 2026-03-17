'use client'

import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect } from 'react'

interface Corsa { 
  id: number
  cliente: string
  autista: string
  lat: number
  lng: number
  stato: string 
}

interface Autista { 
  id: number
  nome: string
  lat: number
  lng: number
  disponibile: boolean 
}

function FitBounds({ corse, autisti }: { corse: Corsa[], autisti: Autista[] }) {
  const map = useMap()
  useEffect(() => {
    const allCoords: [number, number][] = [
      ...corse.filter(c => c.lat && c.lng).map(c => [c.lat, c.lng]),
      ...autisti.filter(a => a.lat && a.lng).map(a => [a.lat, a.lng])
    ]
    if (allCoords.length) {
      map.fitBounds(allCoords)
    }
  }, [corse, autisti, map])
  return null
}

interface MapProps {
  corse: Corsa[]
  autisti: Autista[]
  showCorse: boolean
  showAutisti: boolean
}

export default function MapLive({ corse, autisti, showCorse, showAutisti }: MapProps) {
  // Icone separate e preload corretto
  const corsaIcon = new L.Icon({
    iconUrl: '/icons/car-red.png',
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  })

  const autistaIcon = new L.Icon({
    iconUrl: '/icons/car-green.png',
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  })

  return (
    <MapContainer 
      center={[45.4642, 9.19]} 
      zoom={13} 
      style={{ height: '100%', width: '100%' }}
    >
      <TileLayer
        attribution='&copy; OpenStreetMap contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      <FitBounds corse={corse} autisti={autisti} />

      {showCorse && corse.map(c => (
        <Marker 
          key={`corsa-${c.id}`} 
          position={[c.lat, c.lng]} 
          icon={corsaIcon}
        >
          <Popup>
            <strong>Corsa #{c.id}</strong><br/>
            Cliente: {c.cliente}<br/>
            Autista: {c.autista}<br/>
            Stato: {c.stato}
          </Popup>
        </Marker>
      ))}

      {showAutisti && autisti.map(a => (
        <Marker 
          key={`autista-${a.id}`} 
          position={[a.lat, a.lng]} 
          icon={autistaIcon}
        >
          <Popup>
            <strong>{a.nome}</strong><br/>
            {a.disponibile ? 'Autista disponibile' : 'Non disponibile'}
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  )
}