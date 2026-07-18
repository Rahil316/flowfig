import { Container, render, Text, VerticalSpace } from '@create-figma-plugin/ui'
import { h } from 'preact'

function Plugin() {
  return (
    <Container space="medium">
      <VerticalSpace space="small" />
      <Text>Flowfig — Scrape symbol table</Text>
      <VerticalSpace space="small" />
    </Container>
  )
}

export default render(Plugin)
