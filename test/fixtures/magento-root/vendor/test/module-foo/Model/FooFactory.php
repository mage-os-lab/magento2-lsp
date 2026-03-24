<?php

namespace Test\Foo\Model;

class FooFactory
{
    public function create(): Foo
    {
        return new Foo();
    }
}
