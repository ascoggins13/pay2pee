// partner/screens/PartnerHomeScreen.js
import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';

const PartnerHomeScreen = ({ navigation }) => {
  const [isLive, setIsLive] = useState(false);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Get Paid to Share Your Bathroom</Text>
      <Text style={styles.subtitle}>Earn money when travelers use your clean bathroom</Text>
     
      <Image source={require('../assets/bathroom-icon.png')} style={styles.icon} />
     
      {!isLive ? (
        <TouchableOpacity
          style={styles.signupButton}
          onPress={() => navigation.navigate('Signup')}
        >
          <Text style={styles.buttonText}>Sign Up as a Partner</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.liveContainer}>
          <Text style={styles.earningsText}>You've earned: $127.50</Text>
          <Text style={styles.visitorsText}>24 visitors this week</Text>
         
          <TouchableOpacity
            style={styles.goLiveButton}
            onPress={() => setIsLive(false)}
          >
            <Text style={styles.buttonText}>Go Offline</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 10,
    textAlign: 'center',
  },
  // ... other styles
});

export default PartnerHomeScreen;

