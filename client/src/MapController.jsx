
function MapController({ focus }) {
    const map = useMap();
    useEffect(() => {
        if (focus?.center) {
            map.flyTo(focus.center, focus.zoom || 14, { duration: 1.5 });
        }
    }, [focus, map]);
    return null;
}
