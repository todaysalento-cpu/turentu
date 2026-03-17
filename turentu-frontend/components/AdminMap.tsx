'use client'

import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'

interface Corsa { id:number, cliente:string, autista:string, lat:number, lng:number, stato:string }
interface Autista { id:number, nome:string, lat:number, lng:number, disponibile:boolean }

export default function AdminMap({ corse, autisti }: { corse:Corsa[], autisti:Autista[] }) {

  const corsaIcon = new L.Icon({ iconUrl:'/icons/car-red.png', iconSize:[30,30] })
  const autistaIcon = new L.Icon({ iconUrl:'/icons/car-green.png', iconSize:[30,30] })

  function FitBounds({ corse, autisti }: { corse:Corsa[], autisti:Autista[] }) {
    const map = useMap()
    useEffect(() => {
      const allCoords = [
        ...corse.map(c => [c.lat,c.lng]),
        ...autisti.map(a => [a.lat,a.lng])
      ]
      if(allCoords.length) map.fitBounds(allCoords as [number,number][])
    }, [corse, autisti])
    return null
  }

  return (
    <MapContainer center={[45.4642,9.19]} zoom={13} className="w-full h-full">
      <TileLayer
        attribution='&copy; OpenStreetMap contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitBounds corse={corse} autisti={autisti} />
      {corse.map(c=>(
        <Marker key={`corsa-${c.id}`} position={[c.lat,c.lng]} icon={corsaIcon}>
          <Popup>
            <strong>Corsa #{c.id}</strong><br/>
            Cliente: {c.cliente}<br/>
            Autista: {c.autista}<br/>
            Stato: {c.stato}
          </Popup>
        </Marker>
      ))}
      {autisti.map(a=>(
        <Marker key={`autista-${a.id}`} position={[a.lat,a.lng]} icon={autistaIcon}>
          <Popup>{a.nome}</Popup>
        </Marker>
      ))}
    </MapContainer>
  )
}