import { Pressable, StyleSheet, Text } from 'react-native'

type CounterButtonProps = {
  count: number
  onPress: () => void
}

export function CounterButton({ count, onPress }: CounterButtonProps) {
  return (
    <Pressable style={styles.button} onPress={onPress}>
      <Text style={styles.text}>Count: {count}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: {
    marginTop: 16,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: '#4f46e5',
  },
  text: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
})

