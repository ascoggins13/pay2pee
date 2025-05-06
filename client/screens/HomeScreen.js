// client/screens/HomeScreen.js
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import MapView, { Marker } from 'react-native-maps';

const HomeScreen = ({ navigation }) => {
  const [locations, setLocations] = React.useState([]);
  const [userLocation, setUserLocation] = React.useState(null);

  // Fetch nearby locations
  React.useEffect(() => {
    // API call to get nearby bathrooms
  }, []);

  return (
    <View style={styles.container}>
      <MapView
        style={styles.map}
        region={{
          latitude: userLocation?.latitude || 37.78825,
          longitude: userLocation?.longitude || -122.4324,
          latitudeDelta: 0.0922,
          longitudeDelta: 0.0421,
        }}
      >
        {locations.map(loc => (
          <Marker
            key={loc._id}
            coordinate={{ latitude: loc.latitude, longitude: loc.longitude }}
            onPress={() => navigation.navigate('LocationDetails', { location: loc })}
          />
        ))}
      </MapView>
     
      <View style={styles.listContainer}>
        {/* List of nearby locations */}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  map: {
    flex: 0.6,
  },
  listContainer: {
    flex: 0.4,
    backgroundColor: 'white',
  },
});

export default HomeScreen;