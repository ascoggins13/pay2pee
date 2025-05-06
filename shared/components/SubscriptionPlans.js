// shared/components/SubscriptionPlans.js
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

const SubscriptionPlans = ({ onSelect }) => {
  const plans = [
    { id: 'one-time', name: 'One-Time', price: '$3.99', desc: 'Single use' },
    { id: '24-hour', name: '24-Hour Pass', price: '$7.99', desc: 'Unlimited uses for 24 hours' },
    { id: 'weekly', name: 'Weekly', price: '$19.99', desc: 'Save $8 vs daily' },
    { id: 'monthly', name: 'Monthly', price: '$49.99', desc: 'Save $30 vs weekly' },
    { id: 'annual', name: 'Annual', price: '$399.99', desc: 'Save $240 vs monthly' },
  ];

  return (
    <View style={styles.container}>
      {plans.map(plan => (
        <TouchableOpacity
          key={plan.id}
          style={styles.planCard}
          onPress={() => onSelect(plan.id)}
        >
          <Text style={styles.planName}>{plan.name}</Text>
          <Text style={styles.planPrice}>{plan.price}</Text>
          <Text style={styles.planDesc}>{plan.desc}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 15,
  },
  planCard: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 15,
    marginBottom: 10,
  },
  planName: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  // ... other styles
});

export default SubscriptionPlans;

