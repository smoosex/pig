/** Built-in conversation settings notify views independently of installable extensions. */
export interface ConversationFeaturesApi {
  onChanged(listener: () => void): () => void
}
