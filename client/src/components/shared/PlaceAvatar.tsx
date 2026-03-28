import React, { useState, useEffect } from 'react'
import { mapsApi } from '../../api/client'
import { getCategoryIcon } from './categoryIcons'
import type { Place } from '../../types'

interface Category {
  color?: string
  icon?: string
}

interface PlaceAvatarProps {
  place: Pick<Place, 'id' | 'name' | 'image_url' | 'google_place_id' | 'osm_id' | 'lat' | 'lng'>
  size?: number
  category?: Category | null
}

const photoCache = new Map<string, string | null>()
const photoInFlight = new Set<string>()

export default function PlaceAvatar({ place, size = 32, category }: PlaceAvatarProps) {
  const [photoSrc, setPhotoSrc] = useState<string | null>(place.image_url || null)

  useEffect(() => {
    if (place.image_url) { setPhotoSrc(place.image_url); return }
    const photoId = place.google_place_id || place.osm_id
    if (!photoId && !(place.lat && place.lng)) { setPhotoSrc(null); return }

    const cacheKey = photoId || `${place.lat},${place.lng}`
    if (photoCache.has(cacheKey)) {
      const cached = photoCache.get(cacheKey)
      if (cached) setPhotoSrc(cached)
      return
    }

    if (photoInFlight.has(cacheKey)) {
      // Another instance is already fetching, wait for it
      const check = setInterval(() => {
        if (photoCache.has(cacheKey)) {
          clearInterval(check)
          const cached = photoCache.get(cacheKey)
          if (cached) setPhotoSrc(cached)
        }
      }, 200)
      return () => clearInterval(check)
    }
    photoInFlight.add(cacheKey)
    mapsApi.placePhoto(photoId || `coords:${place.lat}:${place.lng}`, place.lat, place.lng, place.name)
      .then((data: { photoUrl?: string }) => {
        if (data.photoUrl) {
          photoCache.set(cacheKey, data.photoUrl)
          setPhotoSrc(data.photoUrl)
        } else {
          photoCache.set(cacheKey, null)
        }
        photoInFlight.delete(cacheKey)
      })
      .catch(() => { photoCache.set(cacheKey, null); photoInFlight.delete(cacheKey) })
  }, [place.id, place.image_url, place.google_place_id, place.osm_id])

  const bgColor = category?.color || '#6366f1'
  const IconComp = getCategoryIcon(category?.icon)
  const iconSize = Math.round(size * 0.46)

  const containerStyle: React.CSSProperties = {
    width: size, height: size,
    borderRadius: '50%',
    overflow: 'hidden',
    flexShrink: 0,
    backgroundColor: bgColor,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  }

  if (photoSrc) {
    return (
      <div style={containerStyle}>
        <img
          src={photoSrc}
          alt={place.name}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={() => setPhotoSrc(null)}
        />
      </div>
    )
  }

  return (
    <div style={containerStyle}>
      <IconComp size={iconSize} strokeWidth={1.8} color="rgba(255,255,255,0.92)" />
    </div>
  )
}
